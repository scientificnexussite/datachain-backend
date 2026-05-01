import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import nodemailer from 'nodemailer';
import pool from './db.js';
import mempool from './mempool.js';
import { DataChain } from './datachain.js';
import validator from './validator.js';
import menuBook, { processReferralBonus } from './menubook.js'; // IMPROVEMENT 4 — static import
import './p2p.js';
import config from './config.json' with { type: 'json' };

// ─── PayPal Configuration ─────────────────────────────────────────────────────
const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE      = process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

// ─── Database Schema Init ─────────────────────────────────────────────────────
pool.query(`
    CREATE TABLE IF NOT EXISTS api_state (
        id VARCHAR(50) PRIMARY KEY,
        data JSONB
    );
    CREATE TABLE IF NOT EXISTS public_keys (
        uid VARCHAR(100) PRIMARY KEY,
        public_key TEXT
    );
    CREATE TABLE IF NOT EXISTS token_verifications (
        ticker VARCHAR(20) PRIMARY KEY,
        verification_code VARCHAR(100),
        is_verified BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS referrals (
        referred_uid VARCHAR(100) PRIMARY KEY,
        referrer_uid VARCHAR(100),
        created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS referral_earnings (
        referrer_uid VARCHAR(100),
        amount_syr DOUBLE PRECISION,
        earned_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(100),
        token VARCHAR(20),
        condition VARCHAR(10),
        target_value DOUBLE PRECISION,
        email VARCHAR(200),
        is_active BOOLEAN DEFAULT TRUE,
        created_at BIGINT
    );
    -- Task 1: Persistent domain ownership verification records.
    -- Each row represents one verification attempt (pending → verified → used).
    -- A 'verified' row is required before /mint-new-cash will proceed.
    -- After a successful deploy the row is marked 'used' so it cannot be reused
    -- for a second ticker (preventing domain squatting abuse).
    CREATE TABLE IF NOT EXISTS domain_verifications (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(100) NOT NULL,
        website_url TEXT NOT NULL,
        verification_key VARCHAR(100) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at BIGINT,
        verified_at BIGINT
    );
    -- Feature A: System Handler addresses for custom token creators.
    -- Each custom token can have one system address that auto-manages liquidity.
    -- Only the token creator can pay to generate one; the address only accepts
    -- the specific token it was created for (enforced in /tx/new).
    CREATE TABLE IF NOT EXISTS system_handlers (
        token_symbol  VARCHAR(20) PRIMARY KEY,
        system_address VARCHAR(100) NOT NULL,
        creator_uid   VARCHAR(100) NOT NULL,
        created_at    BIGINT
    );
`).catch(err => console.error(chalk.red('[DB] API State & Feature tables init failed'), err));

// ─── Express App ──────────────────────────────────────────────────────────────
const app  = express();
app.set('trust proxy', 1);
const port = process.env.PORT || config.network.api_port;

const nexusChain  = new DataChain();
let positionsCache = new Map();

app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
    'https://scientific-nexus-site.vercel.app',
    'https://scientific-nexus-data-chain.vercel.app',
    'https://syrpts-terminal.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

app.use(bodyParser.json({ limit: '100kb' }));

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const server = createServer(app);
const wss    = new WebSocketServer({ server });

global.broadcastWS = (event, data) => {
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(JSON.stringify({ event, data }));
    });
};

// IMPROVEMENT 1 — WebSocket PING/PONG heartbeat handler.
// The client sends { event: 'PING' } every 30 seconds; the server replies with
// { event: 'PONG' }.  This keeps connections alive through Railway's reverse
// proxy (and any other load balancer) that would otherwise silently close idle
// WebSocket connections without triggering onclose on the client.
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.event === 'PING') {
                ws.send(JSON.stringify({ event: 'PONG' }));
            }
        } catch (e) {
            // Malformed message — ignore silently
        }
    });
});

// ─── Rate Limiters ────────────────────────────────────────────────────────────
// Write limiter — kept as-is on all mutation endpoints
const txLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 50,
    keyGenerator: (req) => req.ip,
    message: { error: 'Too many transactions submitted. Please try again later.' }
});

// IMPROVEMENT 5 — Read limiter applied to public data endpoints.
// 200 req/min per IP is generous for legitimate use (charts, explorers, bots)
// while blocking the unthrottled hammering of PostgreSQL-backed read routes.
const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    keyGenerator: (req) => req.ip,
    message: { error: 'Too many read requests. Please slow down.' }
});

// ─── DER Signature Helper ─────────────────────────────────────────────────────
const rawToDer = (rawSigHex) => {
    const toStrictHexInt = (hex) => {
        while (hex.length > 2 && hex.startsWith('00')) hex = hex.substring(2);
        if (parseInt(hex.substring(0, 2), 16) >= 128) hex = '00' + hex;
        return hex;
    };
    let r = toStrictHexInt(rawSigHex.substring(0, 64));
    let s = toStrictHexInt(rawSigHex.substring(64, 128));
    let rLen = (r.length / 2).toString(16).padStart(2, '0');
    let sLen = (s.length / 2).toString(16).padStart(2, '0');
    let seq  = '02' + rLen + r + '02' + sLen + s;
    let seqLen = (seq.length / 2).toString(16).padStart(2, '0');
    return '30' + seqLen + seq;
};

// ─── ECDSA Auth Middleware ─────────────────────────────────────────────────────
const requireWeb3Auth = async (req, res, next) => {
    const { signature, publicKey, uid, ...payloadData } = req.body;
    if (!signature || !publicKey || !uid)
        return res.status(401).json({ error: 'Unauthorized: Missing Web3 ECDSA Signature.' });

    try {
        const pkRes = await pool.query('SELECT public_key FROM public_keys WHERE uid = $1', [uid]);
        if (pkRes.rows.length > 0 && pkRes.rows[0].public_key !== publicKey) {
            return res.status(401).json({ error: 'Unauthorized: Public Key mismatch for this identity.' });
        } else if (pkRes.rows.length === 0) {
            await pool.query('INSERT INTO public_keys (uid, public_key) VALUES ($1, $2)', [uid, publicKey]);
        }

        const verify = crypto.createVerify('SHA256');
        verify.update(JSON.stringify(payloadData));

        let derSignature = signature.length === 128 ? rawToDer(signature) : signature;
        if (!verify.verify(publicKey, derSignature, 'hex')) {
            console.log(chalk.yellow(`[AUTH] Signature validation failed for: ${uid.substring(0, 8)}...`));
            return res.status(401).json({ error: 'Unauthorized: Invalid Cryptographic Signature' });
        }

        req.user = { uid };
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Unauthorized: Malformed Key or Signature Structure' });
    }
};

// ─── PayPal Token Helper ──────────────────────────────────────────────────────
async function getPayPalAccessToken() {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET)
        throw new Error('PayPal credentials not configured on server.');
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
        method: 'POST',
        body: 'grant_type=client_credentials',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const data = await response.json();
    if (!response.ok) throw new Error('Failed to get PayPal Access Token');
    return data.access_token;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
const fixDust = (num) => Number(Number(num).toFixed(8));

const MAX_SUPPLY   = 12_000_000_000;
let currentPrice   = config.blockchain.starting_price;

const apiCache = {
    stats:   { data: null, time: 0 },
    network: { data: null, time: 0 },
    menubook: new Map()
};
const CACHE_TTL = 2000;

let pendingPayPalOrders  = new Map();
let pendingVerifications = new Map();

// ─── Persisted API State ──────────────────────────────────────────────────────
async function loadApiState() {
    try {
        const pRes = await pool.query("SELECT data FROM api_state WHERE id = 'paypal_orders'");
        if (pRes.rows.length > 0) pendingPayPalOrders = new Map(pRes.rows[0].data);

        const vRes = await pool.query("SELECT data FROM api_state WHERE id = 'verifications'");
        if (vRes.rows.length > 0) pendingVerifications = new Map(vRes.rows[0].data);

        console.log(chalk.green('[API] Restored API state from PostgreSQL.'));
    } catch (e) {
        console.warn('[API] DB state load failed. Fresh state initialised.');
    }
}

async function saveApiState() {
    try {
        await pool.query(
            "INSERT INTO api_state (id, data) VALUES ('paypal_orders', $1) ON CONFLICT (id) DO UPDATE SET data = $1",
            [JSON.stringify(Array.from(pendingPayPalOrders.entries()))]
        );
        await pool.query(
            "INSERT INTO api_state (id, data) VALUES ('verifications', $1) ON CONFLICT (id) DO UPDATE SET data = $1",
            [JSON.stringify(Array.from(pendingVerifications.entries()))]
        );
    } catch (e) { console.error('[API] DB state save failed.', e); }
}

// ─── Market Economics ─────────────────────────────────────────────────────────
async function updateMarketEconomics() {
    try {
        await menuBook.ensureLoaded();
        menuBook._initTokenBook('SYR');
        const chainPrice = await nexusChain.getLastMarketPrice(config.blockchain.starting_price);
        currentPrice = menuBook.books['SYR'].lastTradePrice > 0
            ? menuBook.books['SYR'].lastTradePrice
            : chainPrice;
        await menuBook.setInitialPrice(currentPrice, 'SYR');

        menuBook.books['SYR'].asks = menuBook.books['SYR'].asks.filter(a => a.uid !== 'system');
        menuBook.books['SYR'].bids = menuBook.books['SYR'].bids.filter(a => a.uid !== 'system');

        // IMPROVEMENT 2 — only broadcast SYR's MENUBOOK_UPDATE here
        await menuBook.saveOrders('SYR');

        apiCache.stats.time   = 0;
        apiCache.network.time = 0;
        apiCache.menubook.clear();

        if (global.broadcastWS) {
            global.broadcastWS('PRICE_UPDATE', { token: 'SYR', price: currentPrice, timestamp: Date.now() });
        }
    } catch (e) {
        console.error(chalk.red('[ECONOMICS ERROR]'), e);
    }
}

// IMPROVEMENT 6 — Server-side price alert checker.
// Runs after every updateMarketEconomics() call so alerts fire 24/7 even when
// the user's browser tab is closed.
async function checkServerAlerts(token, newPrice) {
    if (!newPrice || !token) return;
    try {
        const res = await pool.query(
            "SELECT id, uid, condition, target_value, email FROM price_alerts WHERE token = $1 AND is_active = TRUE",
            [token]
        );
        if (res.rows.length === 0) return;

        const toFire = res.rows.filter(alert => {
            if (alert.condition === 'above') return newPrice >= alert.target_value;
            if (alert.condition === 'below') return newPrice <= alert.target_value;
            return false;
        });

        if (toFire.length === 0) return;

        // Build the Nodemailer transporter once for this batch
        if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
        });

        for (const alert of toFire) {
            try {
                await transporter.sendMail({
                    from: process.env.GMAIL_USER,
                    to: alert.email,
                    subject: `[Syrpts Alert] ${token} price ${alert.condition} $${alert.target_value}`,
                    text: `Your Syrpts price alert has been triggered.\n\nToken: ${token}\nCondition: ${alert.condition} $${alert.target_value}\nCurrent Price: $${newPrice}\n\nhttps://syrpts-terminal.vercel.app`
                });
                console.log(chalk.cyan(`[ALERT] Email sent for ${token} ${alert.condition} $${alert.target_value}`));
            } catch (mailErr) {
                console.error(chalk.yellow(`[ALERT] Failed to send email for alert ${alert.id}:`), mailErr.message);
            }

            // Deactivate the alert after firing
            pool.query('UPDATE price_alerts SET is_active = FALSE WHERE id = $1', [alert.id]).catch(() => {});
        }
    } catch (e) {
        console.error(chalk.red('[ALERT] Server-side alert check failed:'), e.message);
    }
}

// ─── AUTO-MINER ───────────────────────────────────────────────────────────────
// ─── Task B: System Liquidity Pool ──────────────────────────────────────────
// refreshAllPoolOrders() runs after every successful block and maintains one
// bid and one ask per custom token with an active pool.  The 'system' address
// always has virtual balance to fill these orders (credited by LIQUIDITY_INIT).
async function refreshAllPoolOrders() {
    if (!nexusChain || !nexusChain.state) return;
    await menuBook.ensureLoaded();

    // FIX — Also run market-making for tokens with system handler addresses,
    // even if they don't have a formal liquidityPool entry yet.
    // When the creator sends tokens to nx_sys_... those tokens are held there,
    // but refreshAllPoolOrders previously only iterated liquidityPools tickers.
    // Now we also check all nx_sys_ addresses and add their tickers.
    const tickersToProcess = new Set(Object.keys(nexusChain.state.liquidityPools));
    try {
        const handlerRows = await pool.query('SELECT token_symbol, system_address FROM system_handlers');
        for (const row of handlerRows.rows) {
            tickersToProcess.add(row.token_symbol);
        }
    } catch(e) { /* table may not exist on first boot */ }

    for (const ticker of tickersToProcess) {
        if (ticker === 'SYR') continue; // SYR has its own market-making logic

        menuBook._initTokenBook(ticker);
        const book = menuBook.books[ticker];

        // Remove previous system orders for this token to avoid accumulation
        ['bids', 'asks'].forEach(side => {
            book[side] = book[side].filter(o => o.uid !== 'system');
        });

        // FIX: aggregate tokens from BOTH 'system' address AND any nx_sys_ handler for this ticker.
        // The creator sends tokens to nx_sys_... but the system needs to use them for market-making.
        let combinedTokenBal = nexusChain.state.getBalance('system', ticker);
        let handlerAddress   = null;
        try {
            const hRow = await pool.query(
                'SELECT system_address FROM system_handlers WHERE token_symbol = $1 LIMIT 1',
                [ticker]
            );
            if (hRow.rows.length > 0) {
                handlerAddress = hRow.rows[0].system_address;
                combinedTokenBal += nexusChain.state.getBalance(handlerAddress, ticker);
            }
        } catch(e) {}

        // Determine pool price: use liquidityPool if available, else derive from menubook last price
        let poolPrice = nexusChain.state.getPoolPrice(ticker);
        if (poolPrice <= 0 && book.lastTradePrice > 0) {
            poolPrice = book.lastTradePrice;
        }
        if (poolPrice <= 0 && book.asks && book.asks.length > 0) {
            poolPrice = book.asks[0].priceUsd;
        }
        if (poolPrice <= 0 || combinedTokenBal <= 0) continue;

        // Update the liquidity pool state to reflect the handler's balance
        if (handlerAddress && combinedTokenBal > 0) {
            nexusChain.state.initPool(ticker);
            const lp = nexusChain.state.liquidityPools[ticker];
            // Sync pool reserves to reflect actual combined token balance
            if (lp.tokenReserve < combinedTokenBal) {
                lp.tokenReserve = combinedTokenBal;
                if (lp.usdReserve <= 0) lp.usdReserve = parseFloat((combinedTokenBal * poolPrice).toFixed(8));
            }
        }

        // Order size: 1% of combined available tokens, capped at 10,000 per side
        const rawOrderSize = Math.min(parseFloat((combinedTokenBal * 0.01).toFixed(8)), 10_000);
        if (rawOrderSize < 1e-6) continue;

        const bidPrice   = parseFloat((poolPrice * 0.995).toFixed(8));
        const askPrice   = parseFloat((poolPrice * 1.005).toFixed(8));
        const systemUsdBal = nexusChain.state.getUsd('system');

        // SELL: limited by combined token balance
        const sellOrderSize = Math.min(rawOrderSize, combinedTokenBal);
        // BUY: limited by system USD balance
        const buyOrderSize  = Math.min(rawOrderSize, bidPrice > 0 ? systemUsdBal / bidPrice : 0);

        if (sellOrderSize >= 1e-6) {
            // Place SELL order from the handler address if it has balance, else from 'system'
            const sellUid = (handlerAddress && nexusChain.state.getBalance(handlerAddress, ticker) >= sellOrderSize)
                ? handlerAddress : 'system';
            await menuBook.addLimitOrder(sellUid, 'SELL', parseFloat(sellOrderSize.toFixed(8)), askPrice, ticker);
        }
        if (buyOrderSize >= 1e-6) {
            await menuBook.addLimitOrder('system', 'BUY', parseFloat(buyOrderSize.toFixed(8)), bidPrice, ticker);
        }

        console.log(chalk.cyan(`[POOL] ${ticker}: price=$${poolPrice.toFixed(4)} tokens=${combinedTokenBal.toFixed(0)} sell=${sellOrderSize.toFixed(2)} buy=${buyOrderSize.toFixed(2)}`));
    }
}

// FIX 1 — The entire auto-miner body is now wrapped in try/catch/finally.
//          The finally block unconditionally resets isMining = false so that a
//          crash inside addBlock() (DB timeout, Worker Thread exit, etc.) can
//          never permanently lock the miner.
//
// FIX 2 — Transactions are NOT permanently cleared from the mempool until
//          addBlock() returns true.  If addBlock() returns false or throws,
//          mempool.restoreTransactions() puts them back so they are retried
//          on the next 5-second tick instead of being silently lost forever.
let isMining = false;
setInterval(async () => {
    if (isMining) return;
    const pendingCount = mempool.getPendingCount();
    if (pendingCount === 0) return;

    isMining = true;
    // FIX 2 — Snapshot the pending batch but keep it recoverable
    const pendingTxs = mempool.getAndClear();

    try {
        const success = await nexusChain.addBlock(pendingTxs, currentPrice);

        if (success) {
            positionsCache.clear();
            await updateMarketEconomics();

            // Run server-side price alert check after every successful block
            await checkServerAlerts('SYR', currentPrice);

            // Task B — Refresh system market-making orders for every custom token
            // that has an active liquidity pool.  After each block, we clear the old
            // system bid/ask and re-place them at the current pool price so the spread
            // always reflects the true pool ratio. This runs silently after the block
            // commit — errors here never affect block validity.
            try {
                await refreshAllPoolOrders();
            } catch (poolErr) {
                console.warn(chalk.yellow('[POOL] Market-making refresh failed:'), poolErr.message);
            }

            // Post-mining cleanup: release locks that were waiting on these txs
            pendingTxs.forEach(tx => {
                if (tx.type === 'USD_WITHDRAWAL' && tx.to === 'system' && tx.isSystemGenerated) {
                    menuBook.removeMintLock(tx.from);
                }
                if (tx.type === 'TRANSFER' && tx.to === 'system' && tx.isSystemGenerated && tx.description === 'Deploy Fee') {
                    menuBook.removeDeployFeeLock(tx.from, tx.amount);
                }
            });

            // FIX 3 — Seed initial liquidity for newly minted custom tokens.
            // Without this, custom tokens have no ask orders in the book so
            // nobody can buy them, no MARKET_TRADE records are ever created,
            // and both charts stay blank forever.
            // We place a seed SELL limit order (10% of supply, max 1 M tokens)
            // at $0.01 on behalf of the deployer. They can cancel and re-price it.
            for (const tx of pendingTxs) {
                if (
                    tx.type === 'MINT' &&
                    tx.tokenSymbol !== 'SYR' &&
                    tx.isSystemGenerated &&
                    tx.to && tx.to !== 'system'
                ) {
                    const seedTicker   = tx.tokenSymbol;
                    const deployerUid  = tx.to;
                    const totalSupply  = tx.amount;
                    // Only seed if this token book has no orders yet
                    await menuBook.ensureLoaded();
                    menuBook._initTokenBook(seedTicker);
                    const book = menuBook.books[seedTicker];
                    if (book.asks.length === 0 && book.bids.length === 0) {
                        const seedAmount = Math.min(
                            parseFloat((totalSupply * 0.10).toFixed(8)),
                            1_000_000
                        );
                        const seedPrice = 0.01; // default starting price
                        if (seedAmount > 0) {
                            await menuBook.addLimitOrder(
                                deployerUid, 'SELL', seedAmount, seedPrice, seedTicker
                            );
                            console.log(chalk.cyan(
                                `[LIQUIDITY] Seeded initial ask for ${seedTicker}: `+
                                `${seedAmount} @ $${seedPrice} (deployer: ${deployerUid.substring(0,12)}...)`
                            ));
                        }
                    }

                    // Task B — Initialise the system liquidity pool for this token.
                    // Pool starts with 5% of total supply (capped at 1M) and a matching
                    // virtual USD reserve at the seed price. These are system-virtual reserves
                    // (no tokens taken from deployer), enabling the system to market-make
                    // immediately so buyers always see a live price in both charts.
                    const poolTokens = Math.min(parseFloat((totalSupply * 0.05).toFixed(8)), 1_000_000);
                    const poolUsd    = parseFloat((poolTokens * 0.01).toFixed(8)); // seedPrice = $0.01
                    if (poolTokens > 0) {
                        await mempool.addTransaction({
                            from: 'system',
                            to:   'system',
                            amount: poolTokens,
                            amountUsd: poolUsd,
                            type: 'LIQUIDITY_INIT',
                            tokenSymbol: seedTicker,
                            timestamp: Date.now(),
                            isSystemGenerated: true,
                            description: 'System Liquidity Pool Init'
                        });
                        console.log(chalk.magenta(
                            `[POOL] Initialised liquidity pool for ${seedTicker}: `+
                            `${poolTokens} tokens / $${poolUsd} USD`
                        ));
                    }
                }
            }
        } else {
            // FIX 2 — Block validation failed; put the transactions back
            console.log(chalk.red('[AUTO-MINER] Block validation failed. Restoring transactions to mempool.'));
            mempool.restoreTransactions(pendingTxs);
        }
    } catch (err) {
        // FIX 1 — Unhandled exception caught; restore transactions so they
        // are not permanently lost, then let the next tick try again.
        console.error(chalk.red('[AUTO-MINER] Exception during mining:'), err.message);
        mempool.restoreTransactions(pendingTxs);
    } finally {
        // FIX 1 — Always release the mining lock, even on exception
        isMining = false;
    }
}, 5000);

// ─── Keep-alive Ping ──────────────────────────────────────────────────────────
const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${port}`;
setInterval(async () => {
    try { await fetch(`${BACKEND_URL}/health`); } catch (e) {}
}, 4 * 60 * 1000);

// ─── Stale State Cleanup ──────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    let updated = false;
    for (const [key, record] of pendingVerifications.entries()) {
        if (now - record.timestamp > 30 * 60 * 1000) { pendingVerifications.delete(key); updated = true; }
    }
    for (const [orderId, orderData] of pendingPayPalOrders.entries()) {
        if (now - orderData.timestamp > 24 * 60 * 60 * 1000) { pendingPayPalOrders.delete(orderId); updated = true; }
    }
    if (updated) saveApiState();
}, 15 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
    res.json({ status: 'alive', chainLength: nexusChain.blockCount, timestamp: Date.now() });
});

app.get('/config', (req, res) => {
    res.json({ paypalClientId: PAYPAL_CLIENT_ID, sandboxMode: process.env.PAYPAL_MODE !== 'live' });
});

// ─── Price Alert Endpoints (IMPROVEMENT 6) ────────────────────────────────────

// POST /alerts/set — store a server-side price alert (persisted in PostgreSQL)
app.post('/alerts/set', requireWeb3Auth, async (req, res) => {
    try {
        const { uid, token, condition, targetValue, email } = req.body;
        if (!uid || !token || !condition || !targetValue || !email)
            return res.status(400).json({ error: 'Missing required alert fields.' });
        if (!['above', 'below'].includes(condition))
            return res.status(400).json({ error: "Condition must be 'above' or 'below'." });
        // Limitation 7 FIX — validate email format before persisting
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
        if (!emailRegex.test(email) || email.length > 200)
            return res.status(400).json({ error: 'Invalid email address format.' });

        await pool.query(
            `INSERT INTO price_alerts (uid, token, condition, target_value, email, is_active, created_at)
             VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
            [uid, token.toUpperCase(), condition, parseFloat(targetValue), email, Date.now()]
        );
        res.json({ success: true, message: 'Server-side price alert registered.' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save alert.' });
    }
});

// POST /alerts/clear — deactivate all server-side alerts for a uid + token
app.post('/alerts/clear', requireWeb3Auth, async (req, res) => {
    try {
        const { uid, token } = req.body;
        if (!uid || !token) return res.status(400).json({ error: 'uid and token are required.' });
        await pool.query(
            'UPDATE price_alerts SET is_active = FALSE WHERE uid = $1 AND token = $2',
            [uid, token.toUpperCase()]
        );
        res.json({ success: true, message: 'Server-side alerts cleared.' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to clear alerts.' });
    }
});

// POST /alert/email — legacy immediate email trigger (kept for backwards compat)
app.post('/alert/email', async (req, res) => {
    const { uid, email, token, condition, targetValue, currentPrice: alertPrice } = req.body;
    const recipient = email || process.env.GMAIL_USER;
    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS)
        return res.status(500).json({ error: 'Email not configured on server.' });

    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
        });
        await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: recipient,
            subject: `[Syrpts Alert] ${token} price alert triggered`,
            text: `Token: ${token}\nCondition: ${condition}\nTarget: ${targetValue}\nCurrent Price: ${alertPrice}\nLink: https://syrpts-terminal.vercel.app`
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.toString() });
    }
});

// ─── Menu Book ────────────────────────────────────────────────────────────────
app.get('/menubook', async (req, res) => {
    const token = req.query.token || 'SYR';
    await menuBook.ensureLoaded();
    const now = Date.now();
    const cached = apiCache.menubook.get(token);

    if (cached && (now - cached.time < CACHE_TTL)) return res.json(cached.data);

    const book = menuBook.books[token];
    const data = book
        ? { bids: book.bids || [], asks: book.asks || [], marketData: menuBook.getSpread(token) }
        : { bids: [], asks: [], marketData: { highestBid: 0, lowestAsk: 0, spread: 0, lastTradePrice: 0 } };

    apiCache.menubook.set(token, { data, time: now });
    res.json(data);
});

// ─── Network Stats ────────────────────────────────────────────────────────────
app.get('/network', (req, res) => {
    if (Date.now() - apiCache.network.time < CACHE_TTL && apiCache.network.data)
        return res.json(apiCache.network.data);
    apiCache.network.data = {
        chainLength: nexusChain.blockCount,
        difficulty:  nexusChain.difficulty,
        mempoolCount: mempool.getPendingCount()
    };
    apiCache.network.time = Date.now();
    res.json(apiCache.network.data);
});

// ─── Price History (IMPROVEMENT 5 — readLimiter applied) ─────────────────────
app.get('/pricehistory', readLimiter, async (req, res) => {
    const limit  = parseInt(req.query.limit)  || 500;
    const offset = parseInt(req.query.offset) || 0;
    const token  = req.query.token || 'SYR';

    if (token === 'SYR') {
        return res.json(nexusChain.priceHistoryCache.slice(offset, offset + limit));
    }

    try {
        const dbRes = await pool.query(
            `SELECT timestamp_ms as time, (amount_usd / amount) as price
             FROM transactions
             WHERE token_symbol = $1 AND type = 'MARKET_TRADE' AND amount > 0 AND amount_usd > 0
             ORDER BY timestamp_ms ASC
             LIMIT $2 OFFSET $3`,
            [token, limit, offset]
        );
        // FIX 1: was returning { time } but syrpts-app.js reads { timestamp }.
        // Now returns { timestamp } to match SYR's priceHistoryCache format.
        // This was the primary cause of all custom token charts being blank.
        res.json(dbRes.rows.map(r => ({ timestamp: parseInt(r.time), price: parseFloat(r.price) })));
    } catch (e) {
        res.json([]);
    }
});

// ─── Candlestick / OHLCV with timeframe support ──────────────────────────────
// Supported timeframes: 1H (default), 4H, 1D, 1W
// Returns OHLCV candles for any token from the DB.
// Falls back to pricehistory line data as {timestamp,price} when no MARKET_TRADE
// rows exist yet, so the chart always shows something even before first trade.
app.get('/api/chart/kline', async (req, res) => {
    try {
        const { symbol = 'SYR', timeframe = '1H' } = req.query;

        // Build the time-bucket expression based on timeframe
        let truncExpr;
        let sinceMs = null;  // optional look-back window for recent timeframes
        // Supported timeframes: 1m, 3m, 5m, 15m, 30m, 45m, 1H, 2H, 3H, 4H, 1D, 1W, 1M, ALL
        // For sub-hour timeframes we use minute-level floor truncation via integer math.
        switch (timeframe) {
            case '1m':
                truncExpr = `to_timestamp(floor(timestamp_ms / 60000) * 60)`;
                sinceMs = Date.now() - 2 * 60 * 60 * 1000; // 2 hours
                break;
            case '3m':
                truncExpr = `to_timestamp(floor(timestamp_ms / 180000) * 180)`;
                sinceMs = Date.now() - 6 * 60 * 60 * 1000; // 6 hours
                break;
            case '5m':
                truncExpr = `to_timestamp(floor(timestamp_ms / 300000) * 300)`;
                sinceMs = Date.now() - 12 * 60 * 60 * 1000; // 12 hours
                break;
            case '15m':
                truncExpr = `to_timestamp(floor(timestamp_ms / 900000) * 900)`;
                sinceMs = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days
                break;
            case '30m':
                truncExpr = `to_timestamp(floor(timestamp_ms / 1800000) * 1800)`;
                sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
                break;
            case '45m':
                truncExpr = `to_timestamp(floor(timestamp_ms / 2700000) * 2700)`;
                sinceMs = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days
                break;
            case '2H':
                truncExpr = `date_trunc('hour', to_timestamp(timestamp_ms / 1000)) - (extract(hour from to_timestamp(timestamp_ms/1000))::int % 2) * interval '1 hour'`;
                sinceMs = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days
                break;
            case '3H':
                truncExpr = `date_trunc('hour', to_timestamp(timestamp_ms / 1000)) - (extract(hour from to_timestamp(timestamp_ms/1000))::int % 3) * interval '1 hour'`;
                sinceMs = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days
                break;
            case '4H':
                // Group into 4-hour buckets
                truncExpr = `date_trunc('hour', to_timestamp(timestamp_ms / 1000)) - (extract(hour from to_timestamp(timestamp_ms/1000))::int % 4) * interval '1 hour'`;
                sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
                break;
            case '1D':
                truncExpr = `date_trunc('day', to_timestamp(timestamp_ms / 1000))`;
                sinceMs = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 year
                break;
            case '1W':
                truncExpr = `date_trunc('week', to_timestamp(timestamp_ms / 1000))`;
                sinceMs = null; // all time
                break;
            case '1M':
                truncExpr = `date_trunc('month', to_timestamp(timestamp_ms / 1000))`;
                sinceMs = null; // all time
                break;
            case 'ALL':
                // Show all available daily candles regardless of age.
                // Used by DelChain's token dashboard so custom tokens always show
                // their full history even if their first trade was months ago.
                truncExpr = `date_trunc('day', to_timestamp(timestamp_ms / 1000))`;
                sinceMs = null; // absolutely no time filter
                break;
            default: // '1H'
                truncExpr = `date_trunc('hour', to_timestamp(timestamp_ms / 1000))`;
                sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
                break;
        }

        const sinceFilter = sinceMs ? `AND timestamp_ms >= ${sinceMs}` : '';

        const dbRes = await pool.query(
            `SELECT
                ${truncExpr} as time,
                (array_agg(amount_usd / amount ORDER BY timestamp_ms ASC))[1]  as open,
                MAX(amount_usd / amount) as high,
                MIN(amount_usd / amount) as low,
                (array_agg(amount_usd / amount ORDER BY timestamp_ms DESC))[1] as close,
                SUM(amount) as volume
             FROM transactions
             WHERE token_symbol = $1 AND type = 'MARKET_TRADE' AND amount > 0 AND amount_usd > 0
             ${sinceFilter}
             GROUP BY time
             ORDER BY time ASC
             LIMIT 500`,
            [symbol]
        );

        let formatted = dbRes.rows.map(r => ({
            time:   new Date(r.time).getTime(),
            open:   parseFloat(r.open),
            high:   parseFloat(r.high),
            low:    parseFloat(r.low),
            close:  parseFloat(r.close),
            volume: parseFloat(r.volume)
        }));

        // If no OHLCV rows yet, fall back to pricehistory line data so the chart
        // is never completely blank — "Awaiting First Trade" only shows when there
        // is truly zero price data in the entire DB for this token.
        if (formatted.length === 0) {
            const lineRes = await pool.query(
                `SELECT timestamp_ms as ts, (amount_usd / amount) as price
                 FROM transactions
                 WHERE token_symbol = $1 AND type = 'MARKET_TRADE' AND amount > 0 AND amount_usd > 0
                 ORDER BY timestamp_ms ASC LIMIT 500`,
                [symbol]
            );
            if (lineRes.rows.length > 0) {
                // Convert raw trade rows into single-point pseudo-candles for line rendering
                formatted = lineRes.rows.map(r => {
                    const p = parseFloat(r.price);
                    return {
                        time: parseInt(r.ts),
                        open: p, high: p, low: p, close: p, volume: 0
                    };
                });
            }
        }

        // Final fallback: if still empty, seed from the MINT transaction.
        // priceUsd on MINT is now stored as 0 for custom tokens (FIX 2 from previous update)
        // so we only use this if price_usd > 0 (i.e. it was stored before that fix).
        if (formatted.length === 0) {
            const mintRes = await pool.query(
                `SELECT price_usd, timestamp_ms FROM transactions WHERE type = 'MINT' AND token_symbol = $1 AND price_usd > 0 LIMIT 1`,
                [symbol]
            );
            if (mintRes.rows.length > 0) {
                const initPrice = parseFloat(mintRes.rows[0].price_usd);
                formatted.push({
                    time: new Date(parseInt(mintRes.rows[0].timestamp_ms)).getTime(),
                    open: initPrice, high: initPrice, low: initPrice, close: initPrice, volume: 0
                });
            }
        }

        // ── Ultra-fallback: menubook lastTradePrice / lowest ask ──────────────
        // If no MARKET_TRADE records exist in the DB at all for this token, but the
        // menubook has a live price (e.g. the seed SELL order was partially filled or
        // the deployer set an initial ask), synthesise a single candle from that price.
        // This eliminates the "Awaiting First Trade" overlay for tokens that have a
        // known price in the order book even before the first DB-confirmed trade.
        if (formatted.length === 0) {
            try {
                await menuBook.ensureLoaded();
                menuBook._initTokenBook(symbol);
                const book = menuBook.books[symbol];
                let fallbackPrice = (book && book.lastTradePrice > 0) ? book.lastTradePrice : null;
                if (!fallbackPrice && book && book.asks && book.asks.length > 0) {
                    fallbackPrice = book.asks[0].priceUsd;  // lowest ask as seed price
                }
                if (fallbackPrice && fallbackPrice > 0) {
                    formatted.push({
                        time:   Date.now(),
                        open:   fallbackPrice,
                        high:   fallbackPrice,
                        low:    fallbackPrice,
                        close:  fallbackPrice,
                        volume: 0
                    });
                }
            } catch (mbErr) {
                // Non-fatal: leave chart empty if menubook lookup fails
            }
        }

        res.json(formatted);
    } catch (e) {
        res.status(500).json({ error: 'Chart data unavailable' });
    }
});

// ─── Trending (IMPROVEMENT 5 — readLimiter applied) ──────────────────────────
app.get('/trending', readLimiter, async (req, res) => {
    try {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const dbRes = await pool.query(
            `SELECT token_symbol, SUM(amount_usd) as volume_24h
             FROM transactions
             WHERE type = 'MARKET_TRADE' AND timestamp_ms > $1
             GROUP BY token_symbol
             ORDER BY volume_24h DESC
             LIMIT 5`,
            [oneDayAgo]
        );
        res.json(dbRes.rows);
    } catch (e) {
        res.status(500).json({ error: 'Trending fetch failed' });
    }
});

// ─── Referral Sign-up (TASK 1: Now requireWeb3Auth-secured) ──────────────────
// uid is taken from req.user.uid (the authenticated wallet) — NOT the request body —
// so a user cannot falsely assign a referrer to someone else's wallet.
app.post('/referral/signup', txLimiter, requireWeb3Auth, async (req, res) => {
    const uid      = req.user.uid;          // authenticated wallet address
    const { referrer } = req.body;
    if (!referrer || uid === referrer)
        return res.status(400).json({ error: 'Invalid referral code.' });
    try {
        // Prevent double-signing: if a referral already exists for this uid, reject
        const existing = await pool.query(
            'SELECT 1 FROM referrals WHERE referred_uid = $1 LIMIT 1',
            [uid]
        );
        if (existing.rows.length > 0)
            return res.status(409).json({ error: 'A referrer is already registered for this wallet.' });

        await pool.query(
            'INSERT INTO referrals (referred_uid, referrer_uid, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [uid, referrer, Date.now()]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to register referral.' });
    }
});

// ─── Token List (IMPROVEMENT 5 readLimiter; FEATURE: logoUrl) ────────────────
app.get('/tokens', readLimiter, async (req, res) => {
    try {
        const tokensObj = Object.keys(nexusChain.state.balances);
        let mintDataMap = new Map();

        try {
            const dbRes = await pool.query(
                `SELECT token_symbol, description, platform_type, to_address, price_usd
                 FROM transactions WHERE type = 'MINT' AND token_symbol = ANY($1)`,
                [tokensObj]
            );
            const verRes = await pool.query(
                `SELECT ticker, is_verified FROM token_verifications WHERE ticker = ANY($1)`,
                [tokensObj]
            );

            const verMap = new Map(verRes.rows.map(r => [r.ticker, r.is_verified]));

            dbRes.rows.forEach(row => {
                // FEATURE — Parse logoUrl from the description JSON field.
                // No schema change needed: logoUrl is stored inside the existing
                // description JSONB alongside name, desc, and url.
                let parsedDesc = {};
                try { parsedDesc = JSON.parse(row.description || '{}'); } catch (e) {}

                mintDataMap.set(row.token_symbol, {
                    description:  row.description || '',
                    platformType: row.platform_type || '',
                    owner:        row.to_address || '',
                    initialPrice: parseFloat(row.price_usd) || 0,
                    isVerified:   verMap.get(row.token_symbol) || false,
                    logoUrl:      parsedDesc.logoUrl || ''
                });
            });
        } catch (e) {
            console.error(chalk.yellow('[API] Bulk MINT query failed, proceeding with empty metadata.'));
        }

        const tokens = tokensObj.map(ticker => {
            let totalCirculating = 0;
            let totalHolders     = 0;   // FIX — count holders in the same loop, no extra DB query
            for (const address in nexusChain.state.balances[ticker]) {
                const bal = nexusChain.state.balances[ticker][address];
                if (address !== 'system') {
                    totalCirculating += bal;
                    if (bal > 0) totalHolders++;
                }
            }
            const supply    = ticker === 'SYR' ? (MAX_SUPPLY - nexusChain.getRemainingSupply('SYR')) : totalCirculating;
            const lastPrice = menuBook.books[ticker]?.lastTradePrice || 0;
            const meta      = mintDataMap.get(ticker) || { description: '', platformType: '', owner: '', initialPrice: 0, isVerified: false, logoUrl: '' };

            return {
                ticker,
                supply,
                totalHolders,   // FIX — now included so Global Chains can display holder count
                lastPrice,
                description:  meta.description,
                platformType: meta.platformType,
                owner:        meta.owner,
                initialPrice: meta.initialPrice,
                isVerified:   meta.isVerified,
                logoUrl:      meta.logoUrl        // FEATURE — included in API response
            };
        });

        res.json(tokens);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch tokens' });
    }
});

// ─── Holders (IMPROVEMENT 5 — readLimiter applied) ────────────────────────────
app.get('/holders/:ticker', readLimiter, async (req, res) => {
    try {
        const ticker       = req.params.ticker;
        const tokenBalances = nexusChain.state.balances[ticker];
        if (!tokenBalances) return res.status(404).json({ error: 'Token not found on ledger.' });

        let holders = [];
        for (const [address, balance] of Object.entries(tokenBalances)) {
            if (address !== 'system' && balance > 0) holders.push({ address, balance: fixDust(balance) });
        }
        holders.sort((a, b) => b.balance - a.balance);
        const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
        res.json({ ticker, totalHolders: holders.length, topHolders: holders.slice(0, limit) });
    } catch (e) {
        res.status(500).json({ error: 'Failed to query holders.' });
    }
});

// ─── Positions ────────────────────────────────────────────────────────────────
app.post('/positions/:uid', requireWeb3Auth, async (req, res) => {
    const uid = req.params.uid;
    if (req.user.uid !== uid) return res.status(403).json({ error: 'Forbidden' });

    // Limitation 9 FIX — time-based TTL (30 s) so stale entries don't live forever
    const POSITIONS_TTL = 30000;
    const cachedPos = positionsCache.get(uid);
    if (cachedPos && (Date.now() - cachedPos.time) < POSITIONS_TTL)
        return res.json({ positions: cachedPos.data });

    // Limitation 1 FIX — Single batch query replaces the N+1 loop-per-token pattern.
    // Previously fired one DB round-trip per token the user holds; now one query
    // for all cost-basis data across every token simultaneously.
    let positionsArr = [];
    try {
        // Collect tokens with positive balance first (in-memory, no DB needed)
        const heldTokens = [];
        for (const token in nexusChain.state.balances) {
            const bal = nexusChain.state.getBalance(uid, token);
            if (bal > 0) heldTokens.push({ token, balance: bal });
        }

        if (heldTokens.length > 0) {
            // One DB call for all cost-basis data across all held tokens
            const batchRes = await pool.query(
                `SELECT token_symbol,
                        SUM(amount)     AS total_acquired,
                        SUM(amount_usd) AS total_spent
                 FROM transactions
                 WHERE to_address = $1 AND type IN ('MARKET_TRADE', 'BUY')
                 GROUP BY token_symbol`,
                [uid]
            );
            const costBasis = new Map(
                batchRes.rows.map(r => [r.token_symbol, {
                    acquired: parseFloat(r.total_acquired) || 0,
                    spent:    parseFloat(r.total_spent)    || 0
                }])
            );

            for (const { token, balance } of heldTokens) {
                const cb = costBasis.get(token);
                const avgPrice = cb && cb.acquired > 0
                    ? (cb.spent / cb.acquired)
                    : (token === 'SYR' ? currentPrice : 0);
                positionsArr.push({ asset: token, qty: balance, avgPrice });
            }
        }
    } catch (e) {
        console.error(chalk.red('[API] Positions batch query failed'), e);
    }
    // Limitation 9 FIX — add a timestamp so stale per-user entries can be TTL-expired
    positionsCache.set(uid, { data: positionsArr, time: Date.now() });
    res.json({ positions: positionsArr });
});

// ─── Order Management ─────────────────────────────────────────────────────────
app.post('/api/orders/cancel', requireWeb3Auth, async (req, res) => {
    try {
        const { orderId, tokenSymbol = 'SYR' } = req.body;
        const uid = req.user.uid;
        const success = await menuBook.cancelOrder(uid, parseInt(orderId), tokenSymbol);
        if (success) {
            await updateMarketEconomics();
            res.json({ success: true, message: 'Order cancelled successfully.' });
        } else {
            res.status(404).json({ error: 'Order not found or already executed.' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to cancel order.' });
    }
});

// FIX Issue 2: Return ALL open orders across ALL tokens for this user.
// Previously tokenSymbol defaulted to 'SYR', so custom token orders were never returned.
// The frontend can then filter client-side by selectedToken or search ticker.
app.post('/api/orders/:uid', requireWeb3Auth, (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: 'Forbidden' });
    const uid = req.params.uid;

    // If tokenSymbol is explicitly provided, return only that token (backward compat)
    const { tokenSymbol } = req.body;
    if (tokenSymbol) {
        return res.json(menuBook.getUserOrders(uid, tokenSymbol));
    }

    // No tokenSymbol: aggregate across ALL known token books
    const allTokens = Object.keys(menuBook.books);
    let allOrders = [];
    for (const t of allTokens) {
        const orders = menuBook.getUserOrders(uid, t);
        allOrders = allOrders.concat(orders);
    }
    // Also check SYR if not in books yet
    if (!allTokens.includes('SYR')) {
        allOrders = allOrders.concat(menuBook.getUserOrders(uid, 'SYR'));
    }
    // Sort by timestamp descending
    allOrders.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json(allOrders);
});

// ─── Limit Orders ─────────────────────────────────────────────────────────────
app.post('/menubook/limit', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { side, amountSyr, priceUsd, tokenSymbol = 'SYR' } = req.body;
        const uid = req.user.uid;

        if (!['BUY', 'SELL'].includes(side) || amountSyr <= 0 || priceUsd <= 0)
            return res.status(400).json({ error: 'Invalid limit order parameters.' });

        const parsedAmount = parseFloat(amountSyr);
        const parsedPrice  = parseFloat(priceUsd);

        if (side === 'BUY') {
            const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol) - mempool.getPendingUsdSpend(uid);
            if (availableUsd < parsedAmount * parsedPrice)
                return res.status(400).json({ error: 'Insufficient available USD.' });
        } else {
            const availableToken = nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol) - mempool.getPendingTokenSpend(uid, tokenSymbol);
            if (availableToken < parsedAmount)
                return res.status(400).json({ error: `Insufficient available ${tokenSymbol}.` });
        }

        const fundsToCheck = side === 'BUY'
            ? (nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol) - mempool.getPendingUsdSpend(uid))
            : (nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol) - mempool.getPendingTokenSpend(uid, tokenSymbol));

        const matchResult = await menuBook.matchMarketOrder(uid, side, parsedAmount, fundsToCheck, parsedPrice, tokenSymbol);

        for (const trade of matchResult.trades) {
            await mempool.addTransaction({
                from: trade.seller, to: trade.buyer,
                amount: trade.amountSyr, amountUsd: trade.amountUsd,
                type: 'MARKET_TRADE', tokenSymbol,
                timestamp: Date.now()
            });
        }

        let order = null;
        if (matchResult.remaining > 0)
            order = await menuBook.addLimitOrder(uid, side, matchResult.remaining, parsedPrice, tokenSymbol);

        await updateMarketEconomics();

        // IMPROVEMENT 4 — Referral bonus called here, after trade is done, once per execution
        if (matchResult.trades.length > 0) {
            await processReferralBonus(uid, matchResult.trades, tokenSymbol);
        }

        // IMPROVEMENT 6 — Check server-side price alerts after every trade
        if (matchResult.trades.length > 0) {
            const lastTradePrice = matchResult.trades[matchResult.trades.length - 1].price;
            await checkServerAlerts(tokenSymbol, lastTradePrice);
        }

        res.status(201).json({ message: 'Limit order processed.', order, executedTrades: matchResult.trades });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Market Orders ────────────────────────────────────────────────────────────
app.post('/menubook/market', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { side, amountSyr, tokenSymbol = 'SYR' } = req.body;
        const uid          = req.user.uid;
        const parsedAmount = parseFloat(amountSyr);

        if (!['BUY', 'SELL'].includes(side) || isNaN(parsedAmount) || parsedAmount <= 0)
            return res.status(400).json({ error: 'Invalid market order parameters.' });

        const availableUsd   = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol) - mempool.getPendingUsdSpend(uid);
        const availableToken = nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol) - mempool.getPendingTokenSpend(uid, tokenSymbol);

        if (side === 'SELL' && parsedAmount > availableToken)
            return res.status(400).json({ error: `Insufficient ${tokenSymbol} balance to execute trade.` });
        if (side === 'BUY' && availableUsd <= 0)
            return res.status(400).json({ error: 'Insufficient USD balance. Deposit funds to execute trade.' });

        const fundsToCheck = side === 'BUY' ? availableUsd : availableToken;
        const matchResult  = await menuBook.matchMarketOrder(uid, side, parsedAmount, fundsToCheck, null, tokenSymbol);

        // ── FIX Issue 4: AMM fallback for custom tokens ────────────────────────────
        // For custom tokens with a system handler (nx_sys_ address), if the orderbook
        // has no matching sell orders, fill from the system handler's token balance at
        // the current pool price. This makes the "Remaining Supply" (tokens sent to the
        // system handler) actually serve as automated market-maker liquidity.
        if (side === 'BUY' && matchResult.remaining > 1e-8 && tokenSymbol !== 'SYR') {
            try {
                // Find the system handler address for this token
                const hRow = await pool.query(
                    'SELECT system_address FROM system_handlers WHERE token_symbol = $1 LIMIT 1',
                    [tokenSymbol]
                );
                if (hRow.rows.length > 0) {
                    const handlerAddr = hRow.rows[0].system_address;
                    const handlerBal  = nexusChain.state.getBalance(handlerAddr, tokenSymbol)
                                      - mempool.getPendingTokenSpend(handlerAddr, tokenSymbol);
                    const poolPrice   = nexusChain.state.getPoolPrice(tokenSymbol) ||
                                       (menuBook.books[tokenSymbol]?.lastTradePrice || 0);

                    if (handlerBal > 1e-8 && poolPrice > 0) {
                        let fillAmount  = fixDust(Math.min(matchResult.remaining, handlerBal));
                        const fillUsd   = fixDust(fillAmount * poolPrice);
                        const remaining = fundsToCheck - matchResult.totalUsdCost;

                        // Respect buyer's USD budget
                        if (fillUsd > remaining) {
                            fillAmount = fixDust(remaining / poolPrice);
                        }

                        if (fillAmount > 1e-8) {
                            // Record the AMM fill as a MARKET_TRADE from the handler address
                            await mempool.addTransaction({
                                from: handlerAddr, to: uid,
                                amount: fillAmount, amountUsd: fixDust(fillAmount * poolPrice),
                                type: 'MARKET_TRADE', tokenSymbol,
                                timestamp: Date.now(), isSystemGenerated: true
                            });

                            // Update pool state: usdReserve increases, tokenReserve decreases
                            nexusChain.state.initPool(tokenSymbol);
                            const lp = nexusChain.state.liquidityPools[tokenSymbol];
                            lp.tokenReserve = fixDust(lp.tokenReserve - fillAmount);
                            lp.usdReserve   = fixDust(lp.usdReserve   + fixDust(fillAmount * poolPrice));
                            menuBook.books[tokenSymbol].lastTradePrice = poolPrice;

                            matchResult.trades.push({ buyer: uid, seller: handlerAddr, amountSyr: fillAmount, amountUsd: fixDust(fillAmount * poolPrice), price: poolPrice, tokenSymbol });
                            matchResult.executedSyr  = fixDust(matchResult.executedSyr  + fillAmount);
                            matchResult.remaining    = fixDust(matchResult.remaining    - fillAmount);
                            matchResult.totalUsdCost = fixDust(matchResult.totalUsdCost + fixDust(fillAmount * poolPrice));
                        }
                    }
                }
            } catch (ammErr) {
                console.warn(chalk.yellow(`[AMM] Custom token fallback error for ${tokenSymbol}:`), ammErr.message);
            }
        }

        // System liquidity fallback for SYR BUY orders with remaining unfilled volume
        if (side === 'BUY' && matchResult.remaining > 1e-8 && tokenSymbol === 'SYR') {
            const systemBalance = nexusChain.getBalance('system', tokenSymbol) - mempool.getPendingTokenSpend('system', tokenSymbol);
            // Centralization Fix 1 — Cap system minting power for SYR.
            // The system can only market-make with SYR it has earned from deploy fees
            // and referral revenue. Hard cap: system balance cannot exceed 2% of MAX_SUPPLY.
            // This gives users a mathematical guarantee on maximum dilution.
            const SYR_SYSTEM_MINT_CAP = MAX_SUPPLY * 0.02; // 2% of 6B = 120M SYR hard cap
            const cappedSystemBalance = Math.min(systemBalance, SYR_SYSTEM_MINT_CAP);
            if (cappedSystemBalance > 0) {
                let tradeAmount = Math.min(matchResult.remaining, cappedSystemBalance);
                const virtualSyrReserve = 5_000_000;
                const virtualUsdReserve = virtualSyrReserve * currentPrice;

                let stepTradeUsd       = parseFloat((tradeAmount * currentPrice).toFixed(8));
                let maxAffordableUsd   = fundsToCheck - matchResult.totalUsdCost;

                if (maxAffordableUsd < stepTradeUsd) {
                    tradeAmount  = parseFloat((maxAffordableUsd / currentPrice).toFixed(8));
                    stepTradeUsd = maxAffordableUsd;
                }

                if (tradeAmount > 1e-8) {
                    await mempool.addTransaction({
                        from: 'system', to: uid,
                        amount: tradeAmount, amountUsd: stepTradeUsd,
                        type: 'MARKET_TRADE', tokenSymbol,
                        timestamp: Date.now(), isSystemGenerated: true
                    });

                    const newSyrReserve = virtualSyrReserve - tradeAmount;
                    const newUsdReserve = (virtualSyrReserve * virtualUsdReserve) / newSyrReserve;
                    currentPrice = parseFloat((newUsdReserve / newSyrReserve).toFixed(6));
                    menuBook.books[tokenSymbol].lastTradePrice = currentPrice;
                    await menuBook.saveOrders(tokenSymbol);

                    matchResult.trades.push({ buyer: uid, seller: 'system', amountSyr: tradeAmount, amountUsd: stepTradeUsd, price: currentPrice, tokenSymbol });
                    matchResult.executedSyr  = fixDust(matchResult.executedSyr  + tradeAmount);
                    matchResult.remaining    = fixDust(matchResult.remaining    - tradeAmount);
                    matchResult.totalUsdCost = fixDust(matchResult.totalUsdCost + stepTradeUsd);
                }
            }
        }

        if (matchResult.trades.length === 0)
            return res.status(400).json({ error: 'No liquidity available in Menu Book to match order.' });

        for (const trade of matchResult.trades) {
            if (trade.seller !== 'system') {
                await mempool.addTransaction({
                    from: trade.seller, to: trade.buyer,
                    amount: trade.amountSyr, amountUsd: trade.amountUsd,
                    type: 'MARKET_TRADE', tokenSymbol,
                    timestamp: Date.now()
                });
            }
        }

        await updateMarketEconomics();

        // IMPROVEMENT 4 — Referral bonus called once per execution, not per fill
        await processReferralBonus(uid, matchResult.trades, tokenSymbol);

        // IMPROVEMENT 6 — Trigger server-side alert check after every market trade
        const lastTradePrice = matchResult.trades[matchResult.trades.length - 1].price;
        await checkServerAlerts(tokenSymbol, lastTradePrice);

        res.status(201).json({
            message: 'Market order executed',
            executedSyr:       matchResult.executedSyr,
            remainingUnfilled: matchResult.remaining,
            totalUsdCost:      matchResult.totalUsdCost,
            slippagePercentage: (matchResult.slippage * 100).toFixed(2) + '%',
            trades: matchResult.trades
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Block Explorer (IMPROVEMENT 5 — readLimiter applied) ────────────────────
app.get('/blocks', readLimiter, async (req, res) => {
    try {
        const totalRes = await pool.query('SELECT COUNT(*) FROM blocks');
        const total    = parseInt(totalRes.rows[0].count);

        let limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
        let offset = parseInt(req.query.offset) || 0;

        const blockRes = await pool.query(
            'SELECT * FROM blocks ORDER BY index DESC LIMIT $1 OFFSET $2',
            [limit, offset]
        );
        if (blockRes.rows.length === 0) return res.json({ blocks: [], total, offset, limit });

        const indices = blockRes.rows.map(b => b.index);
        const txRes   = await pool.query(
            'SELECT * FROM transactions WHERE block_index = ANY($1::int[]) ORDER BY id ASC',
            [indices]
        );

        const txsByBlock = {};
        txRes.rows.forEach(tx => {
            if (!txsByBlock[tx.block_index]) txsByBlock[tx.block_index] = [];
            txsByBlock[tx.block_index].push({
                from: tx.from_address, to: tx.to_address,
                amount: parseFloat(tx.amount), amountUsd: parseFloat(tx.amount_usd),
                type: tx.type, tokenSymbol: tx.token_symbol,
                timestamp: parseInt(tx.timestamp_ms),
                isSystemGenerated: tx.is_system_generated,
                signature: tx.signature, publicKey: tx.public_key,
                platformType: tx.platform_type, description: tx.description
            });
        });

        const page = blockRes.rows.map(b => ({
            index: b.index, timestamp: parseInt(b.timestamp_ms),
            data: txsByBlock[b.index] || [], previousHash: b.previous_hash,
            hash: b.hash, nonce: b.nonce
        }));

        res.json({ blocks: page, total, offset, limit });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch blocks from database.' });
    }
});

// ─── Transaction History (IMPROVEMENT 5 — readLimiter applied) ───────────────
app.get('/txhistory/token/:ticker', readLimiter, async (req, res) => {
    try {
        const ticker = req.params.ticker;
        const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
        const offset = parseInt(req.query.offset) || 0;

        const countRes = await pool.query(
            'SELECT COUNT(*) FROM transactions WHERE token_symbol = $1', [ticker]
        );
        const total = parseInt(countRes.rows[0].count);

        const txRes = await pool.query(
            `SELECT from_address, to_address, amount, amount_usd, type, token_symbol, timestamp_ms, block_index
             FROM transactions WHERE token_symbol = $1 ORDER BY timestamp_ms DESC LIMIT $2 OFFSET $3`,
            [ticker, limit, offset]
        );

        const transactions = txRes.rows.map(tx => ({
            from: tx.from_address, to: tx.to_address,
            amount: parseFloat(tx.amount), amountUsd: parseFloat(tx.amount_usd),
            type: tx.type, tokenSymbol: tx.token_symbol,
            timestamp: parseInt(tx.timestamp_ms), blockIndex: tx.block_index
        }));

        res.json({ transactions, total, ticker });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch global token transaction history.' });
    }
});

app.get('/txhistory/:address', readLimiter, async (req, res) => {
    try {
        const address = req.params.address;
        const token   = req.query.token || 'SYR';
        const limit   = Math.min(parseInt(req.query.limit)  || 50, 200);
        const offset  = parseInt(req.query.offset) || 0;

        const countRes = await pool.query(
            `SELECT COUNT(*) FROM transactions WHERE (from_address = $1 OR to_address = $1) AND token_symbol = $2`,
            [address, token]
        );
        const total = parseInt(countRes.rows[0].count);

        const txRes = await pool.query(
            `SELECT from_address, to_address, amount, amount_usd, type, token_symbol, timestamp_ms, block_index
             FROM transactions WHERE (from_address = $1 OR to_address = $1) AND token_symbol = $2
             ORDER BY timestamp_ms DESC LIMIT $3 OFFSET $4`,
            [address, token, limit, offset]
        );

        const transactions = txRes.rows.map(tx => ({
            from: tx.from_address, to: tx.to_address,
            amount: parseFloat(tx.amount), amountUsd: parseFloat(tx.amount_usd),
            type: tx.type, tokenSymbol: tx.token_symbol,
            timestamp: parseInt(tx.timestamp_ms), blockIndex: tx.block_index
        }));

        res.json({ transactions, total, address, token });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch transaction history.' });
    }
});

// ─── Balances ─────────────────────────────────────────────────────────────────
app.get('/balance/:address', (req, res) => {
    const token    = req.query.token || 'SYR';
    const totalSyr = nexusChain.getBalance(req.params.address, token);
    const lockedSyr = menuBook.getLockedToken(req.params.address, token);
    res.json({ address: req.params.address, token, balance: totalSyr - lockedSyr, total: totalSyr, locked: lockedSyr });
});

app.get('/stats', (req, res) => {
    const token = (req.query.token || 'SYR').toUpperCase();

    // For SYR, use cached stats
    if (token === 'SYR') {
        if (Date.now() - apiCache.stats.time < CACHE_TTL && apiCache.stats.data) return res.json(apiCache.stats.data);
        const remaining = nexusChain.getRemainingSupply('SYR');
        apiCache.stats.data = {
            maxSupply: MAX_SUPPLY,
            remainingSupply: remaining,
            circulatingSupply: MAX_SUPPLY - remaining,
            currentPrice,
            marketCap: (MAX_SUPPLY - remaining) * currentPrice
        };
        apiCache.stats.time = Date.now();
        return res.json(apiCache.stats.data);
    }

    // FIX: For custom tokens, return token-specific stats including:
    //   - circulatingSupply: tokens held by real users (not system/handler addresses)
    //   - handlerSupply: tokens sent to the system handler address (this is what
    //     the UI shows as "Remaining Supply" for custom tokens — it's the amount
    //     the creator has deposited for automated market-making)
    const tokenBals = nexusChain.state.balances[token] || {};
    let circulating = 0;
    let handlerSupply = 0;
    for (const addr in tokenBals) {
        const bal = tokenBals[addr] || 0;
        if (addr.startsWith('nx_sys_')) {
            handlerSupply += bal;   // tokens in the system handler = "remaining" pool
        } else if (addr !== 'system' && addr !== 'liquidity-pool') {
            circulating += bal;     // tokens held by real users
        }
    }
    const tokenPrice = menuBook.books[token]?.lastTradePrice || menuBook.books[token]?.asks?.[0]?.priceUsd || 0;
    res.json({
        token,
        circulatingSupply: circulating,
        handlerSupply,               // amount the creator sent to the system handler
        remainingSupply: handlerSupply, // shown as "Remaining Supply" in the UI ticker
        currentPrice: tokenPrice,
        marketCap: circulating * tokenPrice
    });
});

app.get('/supply',        (req, res) => res.json({ remainingSupply: nexusChain.getRemainingSupply('SYR') }));
app.get('/miner-balance', (req, res) => res.json({ address: config.blockchain.miner_address, balance: nexusChain.getBalance(config.blockchain.miner_address, 'SYR') }));

// ─── Transaction Submission ───────────────────────────────────────────────────
app.post('/tx/new', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { signature, publicKey, uid, ...payloadData } = req.body;
        const tx = { ...payloadData, amount: parseFloat(payloadData.amount) };
        if (signature && publicKey) { tx.signature = signature; tx.publicKey = publicKey; tx.uid = uid; }

        const { from, type, tokenSymbol = 'SYR' } = tx;

        if (['BUY', 'SELL', 'MARKET_TRADE'].includes(type))
            return res.status(400).json({ error: 'Trades must be routed through /menubook endpoints.' });

        if (type === 'TRANSFER') {
            if (from !== req.user.uid) return res.status(403).json({ error: 'Forbidden: Originating address mismatch.' });
            if ((nexusChain.getBalance(from, tokenSymbol) - menuBook.getLockedToken(from, tokenSymbol) - mempool.getPendingTokenSpend(from, tokenSymbol)) < tx.amount)
                return res.status(400).json({ error: `Insufficient ${tokenSymbol} balance.` });

            // Feature A — Smart Token Validation for system handler addresses.
            // If the recipient is a known system handler address, verify that the
            // token being sent matches the token that address was created for.
            // This prevents accidental or malicious cross-token transfers to system handlers.
            if (tx.to && tx.to.startsWith('nx_sys_')) {
                try {
                    const handlerRes = await pool.query(
                        'SELECT token_symbol FROM system_handlers WHERE system_address = $1 LIMIT 1',
                        [tx.to]
                    );
                    if (handlerRes.rows.length > 0) {
                        const expectedToken = handlerRes.rows[0].token_symbol;
                        if (expectedToken !== tokenSymbol) {
                            return res.status(400).json({
                                error: `This system address only accepts ${expectedToken} tokens. You cannot send ${tokenSymbol} to it.`
                            });
                        }
                    }
                } catch (valErr) {
                    console.warn(chalk.yellow('[TX] System handler validation warning:'), valErr.message);
                }
            }
        } else if (type === 'USD_WITHDRAWAL') {
            if (from !== req.user.uid) return res.status(403).json({ error: 'Forbidden: Originating address mismatch.' });
            if ((nexusChain.state.getUsd(from) - menuBook.getLockedUsd(from, tokenSymbol) - mempool.getPendingUsdSpend(from)) < tx.amount)
                return res.status(400).json({ error: 'Insufficient USD balance.' });
        } else if (type === 'MINT' && from !== 'system') {
            return res.status(403).json({ error: 'Forbidden: Only system can mint assets.' });
        } else if (type === 'USD_DEPOSIT' && from !== 'paypal-gateway') {
            return res.status(403).json({ error: 'Forbidden: Only gateway can authorise deposits.' });
        } else if (!['USD_DEPOSIT', 'MINT'].includes(type)) {
            return res.status(400).json({ error: 'Invalid transaction type.' });
        }

        if (!validator.validateTransactionPayload(tx))
            return res.status(400).json({ error: 'Malformed payload or invalid cryptography.' });

        if (await mempool.addTransaction(tx)) {
            res.status(201).json({ message: 'Transaction added to mempool.', tx });
        } else {
            res.status(400).json({ error: 'MEMPOOL_FULL_OR_REPLAY' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error.' });
    }
});

// ─── Domain Verification ──────────────────────────────────────────────────────
app.post('/register-website', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { websiteUrl } = req.body;
        const uid = req.user.uid;
        if (!websiteUrl || !websiteUrl.startsWith('http'))
            return res.status(400).json({ error: 'Invalid platform URL format.' });

        const key = 'nx_' + crypto.randomBytes(16).toString('hex');
        // Keep existing in-memory map for the immediate handshake session
        pendingVerifications.set(uid + websiteUrl, { key, timestamp: Date.now() });
        saveApiState();

        // Task 1 — Also persist to domain_verifications so the verified status
        // survives a server restart and can be checked by /mint-new-cash.
        try {
            await pool.query(
                `INSERT INTO domain_verifications (uid, website_url, verification_key, status, created_at)
                 VALUES ($1, $2, $3, 'pending', $4)`,
                [uid, websiteUrl, key, Date.now()]
            );
        } catch (dbErr) {
            // Non-fatal: the in-memory flow still works; log and continue.
            console.warn(chalk.yellow('[API] domain_verifications persist failed:'), dbErr.message);
        }

        res.json({ key });
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/verify-website', txLimiter, requireWeb3Auth, async (req, res) => {
    const { websiteUrl } = req.body;
    const uid = req.user.uid;

    try {
        const parsedUrl = new URL(websiteUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol))
            return res.status(400).json({ error: 'Invalid protocol specified.' });
        const hostname = parsedUrl.hostname;
        const isLocal = /^(localhost|127\.0\.0\.1|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|0\.0\.0\.0|::1)/.test(hostname);
        if (isLocal || hostname.includes('railway.internal'))
            return res.status(400).json({ error: 'Internal IP addresses and local networks are strictly prohibited.' });
    } catch (e) {
        return res.status(400).json({ error: 'Malformed URL provided.' });
    }

    const record = pendingVerifications.get(uid + websiteUrl);

    try {
        // Bug 5 FIX — 10-second timeout on external fetch to prevent indefinite hangs
        // that would block Express workers and exhaust the Railway connection pool.
        const htmlRes = await fetch(websiteUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
            signal: AbortSignal.timeout(10000)
        }).catch(() => null);

        if (htmlRes && htmlRes.ok) {
            const html = await htmlRes.text();
            if (record && html.includes(record.key)) {
                pendingVerifications.delete(uid + websiteUrl);
                saveApiState();
                // Task 1 — Update the DB record so /mint-new-cash can verify ownership.
                await pool.query(
                    `UPDATE domain_verifications SET status = 'verified', verified_at = $3
                     WHERE uid = $1 AND verification_key = $2 AND status = 'pending'`,
                    [uid, record.key, Date.now()]
                ).catch(() => {});
                return res.json({ verified: true });
            }
        }

        // Fallback: check /syrpts-verify.txt
        if (record) {
            try {
                const parsedUrl = new URL(websiteUrl);
                const txtUrl = `${parsedUrl.protocol}//${parsedUrl.host}/syrpts-verify.txt`;
                const txtRes = await fetch(txtUrl, { signal: AbortSignal.timeout(10000) }).catch(() => null);
                if (txtRes && txtRes.ok) {
                    const text = await txtRes.text();
                    if (text.includes(record.key)) {
                        pendingVerifications.delete(uid + websiteUrl);
                        saveApiState();
                        // Task 1 — Update the DB record so /mint-new-cash can verify ownership.
                        await pool.query(
                            `UPDATE domain_verifications SET status = 'verified', verified_at = $3
                             WHERE uid = $1 AND verification_key = $2 AND status = 'pending'`,
                            [uid, record.key, Date.now()]
                        ).catch(() => {});
                        return res.json({ verified: true });
                    }
                }
            } catch (e) {}
        }

        res.json({ verified: false, error: 'Token missing. Ensure your key is embedded directly or use the syrpts-verify.txt fallback.' });
    } catch (error) {
        res.status(500).json({ error: 'Server encountered an error scanning the specified platform.' });
    }
});

// DNS TXT Verification via Cloudflare DoH
app.get('/verify/:ticker', async (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    try {
        const tRes = await pool.query(
            "SELECT platform_type, description FROM transactions WHERE type = 'MINT' AND token_symbol = $1",
            [ticker]
        );
        if (tRes.rows.length === 0) return res.status(404).json({ error: 'Token not found' });

        let meta = { url: '' };
        try { meta = JSON.parse(tRes.rows[0].description); } catch (e) {}
        if (!meta.url) return res.status(400).json({ error: 'No platform URL configured for this asset.' });

        const domain = new URL(meta.url).hostname;
        const vRes   = await pool.query('SELECT verification_code FROM token_verifications WHERE ticker = $1', [ticker]);
        if (vRes.rows.length === 0) return res.status(404).json({ error: 'Verification code not found for this asset.' });
        const code = vRes.rows[0].verification_code;

        const dnsRes  = await fetch(`https://cloudflare-dns.com/dns-json?name=_syrpts-verify.${domain}&type=TXT`, { headers: { Accept: 'application/dns-json' } });
        const dnsData = await dnsRes.json();
        let verified  = false;
        if (dnsData.Answer) {
            for (const record of dnsData.Answer) {
                if (record.data.includes(code)) verified = true;
            }
        }

        if (verified) {
            await pool.query('UPDATE token_verifications SET is_verified = TRUE WHERE ticker = $1', [ticker]);
            res.json({ verified: true });
        } else {
            res.json({ verified: false, error: 'TXT record mismatch. Ensure your DNS text record is properly propagated.' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Verification service failed' });
    }
});

// ─── Token Minting (Deploy) ───────────────────────────────────────────────────
app.post('/mint-new-cash', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker, supply, platformType, description } = req.body;
        const uid = req.user.uid;

        const parsedSupply = parseFloat(supply);
        if (isNaN(parsedSupply) || parsedSupply <= 0 || parsedSupply > 100_000_000_000)
            return res.status(400).json({ error: 'Invalid supply parameter.' });

        if (!ticker || typeof ticker !== 'string' || ticker.length > 10)
            return res.status(400).json({ error: 'Invalid ticker string parameters.' });
        const customTicker = ticker.toUpperCase();

        if (!/^[A-Z0-9]{1,10}$/.test(customTicker))
            return res.status(400).json({ error: 'Ticker must be 1-10 uppercase alphanumeric characters only.' });

        const RESERVED = ['SYR', 'SYSTEM', 'USD', 'PAYPAL', 'GATEWAY', 'NEXUS'];
        if (RESERVED.includes(customTicker))
            return res.status(400).json({ error: 'Ticker utilises a reserved network identifier.' });

        if (nexusChain.state.balances[customTicker] && Object.keys(nexusChain.state.balances[customTicker]).length > 0)
            return res.status(400).json({ error: 'This ticker already exists.' });

        if (menuBook.hasMintLock(uid))
            return res.status(400).json({ error: 'You already have a minting transaction pending.' });

        // ── Task 1: Domain Ownership Enforcement ──────────────────────────────
        // Parse the platform URL that the deployer specified; this is embedded in
        // the description JSON payload that the deploy wizard sends.  We then look
        // up a 'verified' row in domain_verifications for this uid + URL.
        // If none exists, the deploy is rejected — this closes the bypass where a
        // user could call /mint-new-cash directly without completing the handshake.
        let platformUrl = '';
        try { platformUrl = (JSON.parse(description || '{}').url || '').trim(); } catch(e) {}

        if (!platformUrl || !platformUrl.startsWith('http')) {
            return res.status(400).json({ error: 'Platform URL is required. Please ensure Step 1 of the deploy wizard is complete.' });
        }

        const domainVerRes = await pool.query(
            `SELECT id FROM domain_verifications
             WHERE uid = $1 AND website_url = $2 AND status = 'verified'
             ORDER BY verified_at DESC LIMIT 1`,
            [uid, platformUrl]
        );
        if (domainVerRes.rows.length === 0) {
            return res.status(403).json({
                error: 'Domain ownership not verified. Please complete the verification handshake in the deploy wizard (Step 2) before minting.'
            });
        }
        const verificationDbId = domainVerRes.rows[0].id;

        const deployFeeUsd = 1.00;
        const deployFeeSyr = parseFloat((deployFeeUsd / currentPrice).toFixed(8));

        const availableSyr = nexusChain.getBalance(uid, 'SYR') - menuBook.getLockedToken(uid, 'SYR') - mempool.getPendingTokenSpend(uid, 'SYR');
        if (availableSyr < deployFeeSyr)
            return res.status(400).json({ error: `Deploying custom assets costs $1.00 USD worth of SYR. Insufficient balance (${deployFeeSyr} SYR required).` });

        menuBook.addDeployFeeLock(uid, deployFeeSyr);

        const verificationCode = `syrpts_${crypto.randomBytes(8).toString('hex')}`;
        await pool.query(
            'INSERT INTO token_verifications (ticker, verification_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [customTicker, verificationCode]
        );

        await mempool.addTransaction({
            from: uid, to: 'system', amount: deployFeeSyr,
            type: 'TRANSFER', tokenSymbol: 'SYR',
            timestamp: Date.now(), isSystemGenerated: true, description: 'Deploy Fee'
        });

        await mempool.addTransaction({
            from: 'system', to: uid, amount: parsedSupply,
            type: 'MINT', tokenSymbol: customTicker,
            platformType: platformType || 'website',
            description: description || '',
            priceUsd: 0,  // FIX 2: Custom tokens have no USD price at mint time.
            timestamp: Date.now() + 10, isSystemGenerated: true
        });

        menuBook.addMintLock(uid);

        // Task 1 — Mark the domain verification record as 'used' so it cannot be
        // reused to deploy a second ticker under the same URL without re-verifying.
        await pool.query(
            `UPDATE domain_verifications SET status = 'used' WHERE id = $1`,
            [verificationDbId]
        ).catch(e => console.warn(chalk.yellow('[API] Could not mark domain verification as used:'), e.message));

        res.status(201).json({
            message: `Successfully minted ${parsedSupply} ${customTicker} on the Syrpts Network! Gas fee paid: ${deployFeeSyr} SYR`,
            ticker: customTicker
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── USD Balances ─────────────────────────────────────────────────────────────
app.post('/usd/balance/:uid', requireWeb3Auth, (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: 'Forbidden' });
    const totalUsd  = nexusChain.state.getUsd(req.params.uid);
    const lockedUsd = menuBook.getLockedUsd(req.params.uid, 'SYR');
    res.json({ address: req.params.uid, balance: totalUsd - lockedUsd, total: totalUsd, locked: lockedUsd });
});

// ─── PayPal Deposit ───────────────────────────────────────────────────────────
app.post('/create-paypal-order', requireWeb3Auth, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        if (isNaN(amount) || amount < 1 || amount > 10000)
            return res.status(400).json({ error: 'Invalid amount' });

        const accessToken = await getPayPalAccessToken();
        const response    = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: amount.toFixed(2) } }] })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);

        pendingPayPalOrders.set(data.id, { uid: req.user.uid, timestamp: Date.now() });
        saveApiState();
        res.json({ id: data.id });
    } catch (error) {
        res.status(500).json({ error: '[Sys-err] Payment system offline. Check configuration.' });
    }
});

app.post('/capture-paypal-order', requireWeb3Auth, async (req, res) => {
    try {
        if (req.body.uid !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });
        const orderRecord = pendingPayPalOrders.get(req.body.orderID);
        if (!orderRecord || orderRecord.uid !== req.user.uid)
            return res.status(403).json({ error: 'Order ownership validation mismatch.' });

        const accessToken = await getPayPalAccessToken();
        const response    = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${req.body.orderID}/capture`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);

        pendingPayPalOrders.delete(req.body.orderID);
        saveApiState();

        const capturedAmount = parseFloat(data.purchase_units[0].payments.captures[0].amount.value);
        await mempool.addTransaction({
            from: 'paypal-gateway', to: req.user.uid,
            amount: capturedAmount, type: 'USD_DEPOSIT',
            timestamp: Date.now(), isSystemGenerated: true
        });
        res.json({ status: 'COMPLETED', amount: capturedAmount });
    } catch (error) {
        res.status(500).json({ error: '[Sys-err] Payment system offline. Capture failed.' });
    }
});

// ─── PayPal Withdrawal ────────────────────────────────────────────────────────
app.post('/usd/withdraw', requireWeb3Auth, async (req, res) => {
    try {
        const { uid, amount, paypalEmail } = req.body;
        if (uid !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });

        if (typeof amount !== 'number' || amount < 1)
            return res.status(400).json({ error: 'Invalid withdrawal amount. Minimum is $1.' });
        if (amount > 5000)
            return res.status(400).json({ error: 'Max single withdrawal is $5000.' });
        if (!paypalEmail || !paypalEmail.includes('@'))
            return res.status(400).json({ error: 'Valid PayPal email is required to process withdrawals.' });
        if ((nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, 'SYR') - mempool.getPendingUsdSpend(uid)) < amount)
            return res.status(400).json({ error: 'Insufficient available USD.' });

        try {
            const accessToken = await getPayPalAccessToken();
            const payoutRes   = await fetch(`${PAYPAL_API_BASE}/v1/payments/payouts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
                body: JSON.stringify({
                    sender_batch_header: {
                        sender_batch_id: `wdr_${Date.now()}_${uid.substring(0, 6)}`,
                        email_subject: 'Syrpts Node Withdrawal'
                    },
                    items: [{ recipient_type: 'EMAIL', amount: { value: amount.toFixed(2), currency: 'USD' }, receiver: paypalEmail }]
                })
            });
            const payoutData = await payoutRes.json();
            if (!payoutRes.ok) throw new Error(payoutData.message || 'Payout rejected by PayPal');

            await mempool.addTransaction({
                from: uid, to: 'paypal-gateway',
                amount, type: 'USD_WITHDRAWAL',
                timestamp: Date.now()
            });
            res.json({ success: true, message: 'Withdrawal processed and dispatched.' });
        } catch (paypalErr) {
            console.log(chalk.red('[PAYPAL PAYOUT FAILED] ' + paypalErr.message));
            return res.status(503).json({ error: 'Payout service unavailable. Funds not deducted.' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Referral Earnings (Feature 2) ──────────────────────────────────────────
// GET /api/referrals/:uid — returns this user's referral summary and earnings history
app.get('/api/referrals/:uid', async (req, res) => {
    const uid = req.params.uid;
    if (!uid || uid.length > 200) return res.status(400).json({ error: 'Invalid uid.' });
    try {
        const [earningsRes, countRes] = await Promise.all([
            pool.query(
                'SELECT referrer_uid, amount_syr, earned_at FROM referral_earnings WHERE referrer_uid = $1 ORDER BY earned_at DESC LIMIT 100',
                [uid]
            ),
            pool.query(
                'SELECT COUNT(*) FROM referrals WHERE referrer_uid = $1',
                [uid]
            )
        ]);
        const totalReferrals  = parseInt(countRes.rows[0].count);
        const totalEarned     = earningsRes.rows.reduce((s, r) => s + parseFloat(r.amount_syr), 0);
        res.json({
            uid,
            totalReferrals,
            totalEarned: Number(totalEarned.toFixed(8)),
            earnings: earningsRes.rows.map(r => ({
                amount: parseFloat(r.amount_syr),
                earnedAt: parseInt(r.earned_at)
            }))
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch referral data.' });
    }
});

// ─── Task B: Liquidity Pool Endpoints ────────────────────────────────────────

// POST /liquidity/deposit
// Authenticated — deployer deposits custom tokens into the system pool.
// Tokens are locked in the pool; tokenReserve increases; price drops slightly.
// This is voluntary and free — the deployer gets deeper market liquidity in return.
app.post('/liquidity/deposit', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const uid = req.user.uid;
        let { tokenSymbol, amount } = req.body;
        tokenSymbol = String(tokenSymbol || '').toUpperCase().trim();
        amount = parseFloat(amount);

        if (!tokenSymbol || tokenSymbol === 'SYR')
            return res.status(400).json({ error: 'Token symbol required (non-SYR).' });
        if (isNaN(amount) || amount <= 0)
            return res.status(400).json({ error: 'Amount must be a positive number.' });

        const balance = nexusChain.state.getBalance(uid, tokenSymbol);
        if (balance < amount)
            return res.status(400).json({ error: `Insufficient ${tokenSymbol} balance. Have: ${balance.toFixed(4)}` });

        await mempool.addTransaction({
            from: uid,
            to:   'liquidity-pool',
            amount,
            type: 'LIQUIDITY_DEPOSIT',
            tokenSymbol,
            timestamp: Date.now(),
            description: `Deposit ${amount} ${tokenSymbol} to system pool`
        });

        console.log(chalk.magenta(`[POOL] ${uid.substring(0,12)}... deposited ${amount} ${tokenSymbol}`));
        res.json({ message: `Depositing ${amount} ${tokenSymbol} into the system pool. Your contribution will appear after the next block is mined.` });
    } catch (e) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /liquidity/withdraw
// Authenticated — user pays USD at the current pool price to retrieve tokens.
// usdReserve increases; tokenReserve decreases; pool price is preserved.
app.post('/liquidity/withdraw', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const uid = req.user.uid;
        let { tokenSymbol, amount } = req.body;
        tokenSymbol = String(tokenSymbol || '').toUpperCase().trim();
        amount = parseFloat(amount);

        if (!tokenSymbol || tokenSymbol === 'SYR')
            return res.status(400).json({ error: 'Token symbol required (non-SYR).' });
        if (isNaN(amount) || amount <= 0)
            return res.status(400).json({ error: 'Amount must be a positive number.' });

        const poolPrice = nexusChain.state.getPoolPrice(tokenSymbol);
        if (poolPrice <= 0)
            return res.status(400).json({ error: 'No active liquidity pool for this token.' });

        const lp = nexusChain.state.initPool(tokenSymbol);
        if (lp.tokenReserve < amount)
            return res.status(400).json({ error: `Pool only has ${lp.tokenReserve.toFixed(4)} ${tokenSymbol} available.` });

        const usdCost = parseFloat((amount * poolPrice).toFixed(8));
        const usdBalance = nexusChain.state.getUsd(uid);
        if (usdBalance < usdCost)
            return res.status(400).json({ error: `Insufficient USD. Need $${usdCost.toFixed(4)}, have $${usdBalance.toFixed(4)}.` });

        await mempool.addTransaction({
            from: uid,
            to:   'liquidity-pool',
            amount,
            amountUsd: usdCost,
            priceUsd:  poolPrice,
            type: 'LIQUIDITY_WITHDRAW',
            tokenSymbol,
            timestamp: Date.now(),
            description: `Withdraw ${amount} ${tokenSymbol} from pool @ $${poolPrice}`
        });

        console.log(chalk.magenta(`[POOL] ${uid.substring(0,12)}... withdrew ${amount} ${tokenSymbol} @ $${poolPrice}`));
        res.json({
            message: `Withdrawing ${amount} ${tokenSymbol} for $${usdCost.toFixed(4)} USD. Tokens will arrive after the next block is mined.`,
            poolPrice,
            usdCost
        });
    } catch (e) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /liquidity/:ticker — public pool info for a token
app.get('/liquidity/:ticker', readLimiter, (req, res) => {
    const ticker = String(req.params.ticker || '').toUpperCase().trim();
    if (!ticker || ticker === 'SYR') return res.status(400).json({ error: 'Invalid ticker.' });
    const lp = nexusChain.state.liquidityPools[ticker];
    if (!lp) return res.json({ ticker, active: false, tokenReserve: 0, usdReserve: 0, poolPrice: 0 });
    const poolPrice = nexusChain.state.getPoolPrice(ticker);
    res.json({ ticker, active: lp.tokenReserve > 0 && lp.usdReserve > 0, tokenReserve: lp.tokenReserve, usdReserve: lp.usdReserve, poolPrice });
});

// ─── Feature A: System Handler Endpoints ─────────────────────────────────────

// GET /system-handler/:ticker — Public: check if a handler exists for this token.
// Returns the system address only to the token's creator (other callers get exists:true but no address).
app.get('/system-handler/:ticker', readLimiter, async (req, res) => {
    const ticker = String(req.params.ticker || '').toUpperCase().trim();
    if (!ticker) return res.status(400).json({ error: 'Invalid ticker.' });
    try {
        const row = await pool.query(
            'SELECT system_address, creator_uid FROM system_handlers WHERE token_symbol = $1 LIMIT 1',
            [ticker]
        );
        if (row.rows.length === 0) return res.json({ exists: false });
        // The creator's uid is checked on the authenticated endpoint below;
        // here we return the address only so the frontend can populate the UI.
        // The creator matches via WalletManager.address === tInfo.owner comparison client-side.
        res.json({ exists: true, systemAddress: row.rows[0].system_address, creatorUid: row.rows[0].creator_uid });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch system handler info.' });
    }
});

// POST /system-handler/pay-fee — Authenticated: pay $2 and generate a system address.
// Only the token creator can call this; only one handler per token is allowed.
app.post('/system-handler/pay-fee', txLimiter, requireWeb3Auth, async (req, res) => {
    const uid = req.user.uid;
    const { tokenSymbol, timestamp } = req.body;
    const ticker = String(tokenSymbol || '').toUpperCase().trim();

    if (!ticker || ticker === 'SYR')
        return res.status(400).json({ error: 'Invalid token symbol. Cannot create a system handler for SYR.' });

    try {
        // Validate: token must exist on chain
        const allTokens = Object.keys(nexusChain.state.balances);
        if (!allTokens.includes(ticker))
            return res.status(404).json({ error: `Token ${ticker} not found on the DataChain.` });

        // Validate: authenticated user must be the token creator
        const mintRes = await pool.query(
            `SELECT to_address FROM transactions WHERE type = 'MINT' AND token_symbol = $1 AND is_system_generated = TRUE LIMIT 1`,
            [ticker]
        );
        if (mintRes.rows.length === 0 || mintRes.rows[0].to_address !== uid)
            return res.status(403).json({ error: 'Only the original creator of this token can activate a System Handler.' });

        // Validate: no duplicate handler
        const existingRes = await pool.query(
            'SELECT 1 FROM system_handlers WHERE token_symbol = $1 LIMIT 1',
            [ticker]
        );
        if (existingRes.rows.length > 0)
            return res.status(409).json({ error: `A System Handler already exists for ${ticker}. Use the existing address.` });

        // Validate: user has ≥ $2.00 USD balance
        const usdBalance = nexusChain.state.getUsd(uid);
        const FEE_USD    = 2.00;
        if (usdBalance < FEE_USD)
            return res.status(400).json({ error: `Insufficient USD balance. Need $2.00, have $${usdBalance.toFixed(2)}.` });

        // Deduct $2 fee via USD_WITHDRAWAL transaction
        await mempool.addTransaction({
            from: uid, to: 'system', amount: FEE_USD,
            type: 'USD_WITHDRAWAL', tokenSymbol: ticker,
            timestamp: Date.now(), isSystemGenerated: false,
            description: `System Handler activation fee for ${ticker}`
        });

        // Generate a cryptographically unique system address for this token
        const systemAddress = 'nx_sys_' + crypto.randomBytes(16).toString('hex');

        // Persist to database
        await pool.query(
            'INSERT INTO system_handlers (token_symbol, system_address, creator_uid, created_at) VALUES ($1, $2, $3, $4)',
            [ticker, systemAddress, uid, Date.now()]
        );

        console.log(chalk.magenta(`[SYSTEM HANDLER] Activated for ${ticker}: ${systemAddress} (creator: ${uid.substring(0,12)}...)`));

        res.status(201).json({
            systemAddress,
            message: `System Handler activated for ${ticker}. Fee of $2.00 deducted (will apply after next block).`
        });
    } catch (e) {
        console.error(chalk.red('[SYSTEM HANDLER] pay-fee error:'), e.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── 404 Catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => { res.status(404).json({ error: 'API Node Endpoint Not Found' }); });

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER BOOT
// ═══════════════════════════════════════════════════════════════════════════════
(async () => {
    console.log(chalk.blue('Initializing PostgreSQL API States...'));
    await loadApiState();

    console.log(chalk.blue('Initializing Market Economics...'));

    if (nexusChain.isInitializing) { await nexusChain.isInitializing; }
    await menuBook.ensureLoaded();

    let savedMenuPrice = menuBook.books['SYR']?.lastTradePrice;
    let chainPrice     = await nexusChain.getLastMarketPrice(config.blockchain.starting_price);
    currentPrice       = (savedMenuPrice && savedMenuPrice !== 0.01) ? savedMenuPrice : chainPrice;

    await menuBook.setInitialPrice(currentPrice, 'SYR');

    if (nexusChain.getBalance('system', 'SYR') === 0 && nexusChain.blockCount <= 1) {
        const initTx = {
            from: 'system', to: 'system', amount: MAX_SUPPLY,
            type: 'MINT', tokenSymbol: 'SYR',
            timestamp: Date.now(), isSystemGenerated: true
        };
        await nexusChain.addBlock([initTx]);
    }

    await updateMarketEconomics();

    server.listen(port, '0.0.0.0', () => {
        console.log(chalk.blue.bold(`--- SCIENTIFIC NEXUS API RUNNING ON PORT ${port} ---`));
    });

    process.on('SIGTERM', () => {
        console.log(chalk.yellow.bold('[SYSTEM] SIGTERM received. Shutting down gracefully...'));
        isMining = false;
        setTimeout(() => {
            console.log(chalk.yellow('[SYSTEM] Process exited cleanly.'));
            process.exit(0);
        }, 2000);
    });
})();
