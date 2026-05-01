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

// P2P Marketplace Tables
pool.query(`
    CREATE TABLE IF NOT EXISTS p2p_offers (
        id SERIAL PRIMARY KEY,
        merchant_address VARCHAR(100) NOT NULL,
        asset_symbol VARCHAR(10) NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        amount_locked DOUBLE PRECISION NOT NULL DEFAULT 0,
        rate DOUBLE PRECISION NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        pay_method VARCHAR(50) NOT NULL,
        pay_details TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
        created_at BIGINT NOT NULL,
        merchant_rating DOUBLE PRECISION NOT NULL DEFAULT 5.0,
        trade_count INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS p2p_trades (
        id SERIAL PRIMARY KEY,
        offer_id INT REFERENCES p2p_offers(id),
        buyer_address VARCHAR(100) NOT NULL,
        merchant_address VARCHAR(100) NOT NULL,
        asset_symbol VARCHAR(10) NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        rate DOUBLE PRECISION NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        pay_method VARCHAR(50),
        pay_details TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        buyer_rating INT,
        merchant_rating_val INT,
        dispute_reason TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
    );
`).catch(err => console.error('[DB] P2P tables init failed', err));

// ─── Express App ──────────────────────────────────────────────────────────────
const app  = express();
app.set('trust proxy', 1);
const port = process.env.PORT || config.network.api_port;

const nexusChain  = new DataChain();

// Bootstrap SDTX stable token if not seeded
async function bootstrapSdtX() {
    await nexusChain.isInitializing;
    const sdtxBal = nexusChain.state.balances['SDTX'];
    if (!sdtxBal || Object.keys(sdtxBal).length === 0) {
        console.log('[BOOTSTRAP] Seeding SDTX liquidity pool...');
        const seedTx = {
            from: 'system',
            to: 'system',
            amount: 1000000,
            amountUsd: 1000000,
            type: 'LIQUIDITY_INIT',
            tokenSymbol: 'SDTX',
            timestamp: Date.now(),
            isSystemGenerated: true,
            description: 'SDTX stable token genesis liquidity'
        };
        await nexusChain.addBlock([seedTx], 1.0);
        console.log('[BOOTSTRAP] SDTX seeded with 1,000,000 tokens at $1.00');
    }
}
setTimeout(bootstrapSdtX, 5000);

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
        const pkDer = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
        const isValid = verify.verify(pkDer, derSignature, 'hex');

        if (!isValid) return res.status(401).json({ error: 'Unauthorized: Invalid ECDSA Signature.' });

        req.web3Address = uid;
        next();
    } catch (e) {
        console.error(chalk.red('[Auth] Web3 Auth Error:'), e.message);
        res.status(500).json({ error: 'Authentication processing error.' });
    }
};

// ─── Utility Functions ────────────────────────────────────────────────────────
const MAX_SUPPLY = config.blockchain.max_supply;

let currentPrice = config.blockchain.starting_price;
let isMining = false;

const loadApiState = async () => {
    try {
        const result = await pool.query("SELECT id, data FROM api_state WHERE id IN ('price', 'mining')");
        result.rows.forEach(row => {
            if (row.id === 'price') currentPrice = parseFloat(row.data.value) || config.blockchain.starting_price;
            if (row.id === 'mining') isMining = row.data.value === true;
        });
        console.log(chalk.blue(`[State] Loaded price: $${currentPrice}, mining: ${isMining}`));
    } catch (e) {
        console.error(chalk.red('[State] Failed to load API state:'), e.message);
    }
};

const saveApiState = async () => {
    try {
        await pool.query(`
            INSERT INTO api_state (id, data) VALUES ('price', $1), ('mining', $2)
            ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
        `, [{ value: currentPrice }, { value: isMining }]);
    } catch (e) {
        console.error(chalk.red('[State] Failed to save API state:'), e.message);
    }
};

// ─── Market Economics ─────────────────────────────────────────────────────────
const updateMarketEconomics = async () => {
    if (!nexusChain || !nexusChain.state) return;

    try {
        const tickersToProcess = new Set(Object.keys(nexusChain.state.liquidityPools));
        tickersToProcess.add('SYR');

        for (const ticker of tickersToProcess) {
            try {
                // Get system handler if exists
                const handlerRow = await pool.query('SELECT system_address FROM system_handlers WHERE token_symbol = $1', [ticker]);
                const handlerAddress = handlerRow.rows[0]?.system_address || null;

                let combinedTokenBal = nexusChain.state.getBalance('system', ticker);
                if (handlerAddress) {
                    combinedTokenBal += nexusChain.state.getBalance(handlerAddress, ticker);
                }

                let poolPrice = nexusChain.state.getPoolPrice(ticker);
                if (!poolPrice || poolPrice <= 0) poolPrice = ticker === 'SYR' ? currentPrice : 0.01;

                if (!nexusChain.state.liquidityPools[ticker]) {
                    nexusChain.state.initPool(ticker);
                    const lp = nexusChain.state.liquidityPools[ticker];
                    if (lp) {
                        lp.tokenReserve = combinedTokenBal;
                        lp.usdReserve = combinedTokenBal * poolPrice;
                    }
                }

                const systemUsdBal = nexusChain.state.getUsd('system');

                if (ticker === 'SYR' && combinedTokenBal < 1000 && systemUsdBal > 100) {
                    const buyOrderSize = Math.min(10, systemUsdBal * 0.01);
                    const sellUid = (handlerAddress && nexusChain.state.getBalance(handlerAddress, ticker) >= buyOrderSize)
                        ? handlerAddress : 'system';
                    if (nexusChain.state.getBalance(sellUid, ticker) >= buyOrderSize) {
                        menuBook.placeLimitOrder(sellUid, 'SYR', 'SELL', buyOrderSize, poolPrice * 0.995);
                    }
                }
            } catch (tickerErr) {
                console.error(chalk.yellow(`[Economics] Error processing ${ticker}:`), tickerErr.message);
            }
        }

        if (isMining) {
            const pendingTxs = mempool.getPendingTransactions();
            if (pendingTxs.length > 0) {
                const success = await nexusChain.addBlock(pendingTxs, currentPrice);
                if (success) {
                    mempool.clearProcessedTransactions(pendingTxs.map(t => t.id));
                    await saveApiState();
                    global.broadcastWS('NEW_BLOCK', { blockCount: nexusChain.blockCount, price: currentPrice });
                }
            }
        }
    } catch (e) {
        console.error(chalk.red('[Economics] Update failed:'), e.message);
    }
};

setInterval(updateMarketEconomics, 15000);

// ─── PayPal Helper ────────────────────────────────────────────────────────────
const getPayPalAccessToken = async () => {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
    });
    const data = await response.json();
    if (!data.access_token) throw new Error('PayPal auth failed');
    return data.access_token;
};

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/ping', readLimiter, (req, res) => {
    res.json({ status: 'alive', chainLength: nexusChain.blockCount, timestamp: Date.now() });
});

// ─── Referral System ─────────────────────────────────────────────────────────
app.post('/referral/register', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { referrerUid } = req.body;
        const referredUid = req.web3Address;

        if (!referrerUid || referrerUid === referredUid) {
            return res.status(400).json({ error: 'Invalid referral.' });
        }

        const existing = await pool.query('SELECT * FROM referrals WHERE referred_uid = $1', [referredUid]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Already referred.' });

        await pool.query(
            'INSERT INTO referrals (referred_uid, referrer_uid, created_at) VALUES ($1, $2, $3)',
            [referredUid, referrerUid, Date.now()]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Referral registration failed.' });
    }
});

app.get('/referral/earnings/:uid', readLimiter, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT SUM(amount_syr) as total FROM referral_earnings WHERE referrer_uid = $1',
            [req.params.uid]
        );
        res.json({ totalEarned: parseFloat(result.rows[0]?.total) || 0 });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch referral earnings.' });
    }
});

// ─── Price Alerts ─────────────────────────────────────────────────────────────
app.post('/alert/set', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { token, condition, targetValue, email } = req.body;
        const uid = req.web3Address;
        if (!token || !condition || !targetValue || !email)
            return res.status(400).json({ error: 'Missing fields.' });

        await pool.query(
            'INSERT INTO price_alerts (uid, token, condition, target_value, email, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [uid, token.toUpperCase(), condition, parseFloat(targetValue), email, Date.now()]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to set alert.' });
    }
});

app.get('/alert/list/:uid', readLimiter, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM price_alerts WHERE uid = $1 AND is_active = TRUE ORDER BY created_at DESC',
            [req.params.uid]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch alerts.' });
    }
});

// ─── Token Verification ───────────────────────────────────────────────────────
app.post('/verify/start', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { websiteUrl, ticker } = req.body;
        const uid = req.web3Address;
        if (!websiteUrl || !ticker) return res.status(400).json({ error: 'Missing fields.' });

        const tickerUpper = ticker.toUpperCase();
        const verificationKey = `datachain-verify=${crypto.randomBytes(16).toString('hex')}`;

        await pool.query(
            `INSERT INTO domain_verifications (uid, website_url, verification_key, status, created_at)
             VALUES ($1, $2, $3, 'pending', $4)
             ON CONFLICT DO NOTHING`,
            [uid, websiteUrl, verificationKey, Date.now()]
        );

        res.json({ verificationKey, instructions: `Add a TXT record to your domain with value: ${verificationKey}` });
    } catch (e) {
        res.status(500).json({ error: 'Failed to start verification.' });
    }
});

app.post('/verify/check', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { websiteUrl } = req.body;
        const uid = req.web3Address;

        const row = await pool.query(
            "SELECT * FROM domain_verifications WHERE uid = $1 AND website_url = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
            [uid, websiteUrl]
        );

        if (row.rows.length === 0) return res.status(404).json({ error: 'No pending verification found.' });

        const verif = row.rows[0];
        // In production, you'd do a DNS TXT lookup here
        // For now, mark as verified after a delay (demo)
        await pool.query(
            "UPDATE domain_verifications SET status = 'verified', verified_at = $1 WHERE id = $2",
            [Date.now(), verif.id]
        );

        res.json({ success: true, verified: true });
    } catch (e) {
        res.status(500).json({ error: 'Verification check failed.' });
    }
});

// ─── Blockchain Data ──────────────────────────────────────────────────────────
app.get('/chain/info', readLimiter, async (req, res) => {
    try {
        const chainPrice = await nexusChain.getLastMarketPrice(config.blockchain.starting_price);
        res.json({
            chainLength: nexusChain.blockCount,
            difficulty:  nexusChain.difficulty,
            currentPrice: chainPrice,
            isMining
        });
    } catch (e) {
        res.status(500).json({ error: 'Chain info error.' });
    }
});

app.get('/chain/price-history', readLimiter, async (req, res) => {
    const { offset = 0, limit = 100 } = req.query;
    return res.json(nexusChain.priceHistoryCache.slice(offset, offset + limit));
});

app.get('/chain/blocks', readLimiter, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM blocks ORDER BY timestamp_ms DESC LIMIT 50'
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch blocks.' });
    }
});

app.get('/chain/block/:index', readLimiter, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM blocks WHERE block_index = $1',
            [parseInt(req.params.index)]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Block not found.' });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch block.' });
    }
});

app.get('/chain/tx/:hash', readLimiter, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM transactions WHERE tx_hash = $1',
            [req.params.hash]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Transaction not found.' });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch transaction.' });
    }
});

app.get('/chain/txs/:address', readLimiter, async (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        const result = await pool.query(
            `SELECT * FROM transactions
             WHERE from_address = $1 OR to_address = $1
             ORDER BY timestamp_ms DESC LIMIT $2 OFFSET $3`,
            [req.params.address, parseInt(limit), parseInt(offset)]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch transactions.' });
    }
});

// ─── Token Data ───────────────────────────────────────────────────────────────
app.get('/tokens/list', readLimiter, async (req, res) => {
    try {
        const tokensObj = Object.keys(nexusChain.state.balances);
        const tokens = [];

        for (const ticker of tokensObj) {
            let totalCirculating = 0;
            for (const address in nexusChain.state.balances[ticker]) {
                const bal = nexusChain.state.balances[ticker][address];
                if (bal > 0 && address !== 'system') totalCirculating += bal;
            }
            const supply = ticker === 'SYR' ? (MAX_SUPPLY - nexusChain.getRemainingSupply('SYR')) : totalCirculating;
            const poolPrice = nexusChain.state.getPoolPrice(ticker) || 0.01;

            tokens.push({
                ticker,
                supply,
                circulatingSupply: totalCirculating,
                price: ticker === 'SYR' ? currentPrice : poolPrice,
                marketCap: supply * (ticker === 'SYR' ? currentPrice : poolPrice)
            });
        }

        res.json(tokens);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch token list.' });
    }
});

app.get('/token/:ticker', readLimiter, async (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const tokenBalances = nexusChain.state.balances[ticker];
        if (!tokenBalances) return res.status(404).json({ error: 'Token not found.' });

        let totalSupply = 0;
        for (const addr in tokenBalances) {
            if (tokenBalances[addr] > 0) totalSupply += tokenBalances[addr];
        }

        const poolPrice = nexusChain.state.getPoolPrice(ticker) || (ticker === 'SYR' ? currentPrice : 0.01);
        const verif = await pool.query(
            "SELECT * FROM token_verifications WHERE ticker = $1",
            [ticker]
        );

        res.json({
            ticker,
            totalSupply,
            price: poolPrice,
            marketCap: totalSupply * poolPrice,
            isVerified: verif.rows[0]?.is_verified || false,
            liquidityPool: nexusChain.state.liquidityPools[ticker] || null
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch token info.' });
    }
});

// ─── Balances ─────────────────────────────────────────────────────────────────
app.get('/balance/:uid', readLimiter, async (req, res) => {
    try {
        const { uid } = req.params;
        const balances = {};
        for (const token in nexusChain.state.balances) {
            const bal = nexusChain.state.getBalance(uid, token);
            if (bal > 0) balances[token] = bal;
        }
        const usdBalance = nexusChain.state.getUsd(uid);
        res.json({ uid, balances, usdBalance });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch balance.' });
    }
});

// ─── Order Book ───────────────────────────────────────────────────────────────
app.get('/orderbook/:ticker', readLimiter, (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const book = menuBook.getBook(ticker);
        if (!book) return res.status(404).json({ error: 'No order book found.' });
        res.json({
            ticker,
            bids: book.bids || [],
            asks: book.asks || [],
            lastTradePrice: book.lastTradePrice || currentPrice
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch order book.' });
    }
});

app.post('/order/limit', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker, side, amount, price: limitPrice } = req.body;
        const uid = req.web3Address;

        if (!ticker || !side || !amount || !limitPrice)
            return res.status(400).json({ error: 'Missing fields.' });

        const sym = ticker.toUpperCase();
        const parsedAmount = parseFloat(amount);
        const parsedPrice = parseFloat(limitPrice);

        if (parsedAmount <= 0 || parsedPrice <= 0)
            return res.status(400).json({ error: 'Invalid amount or price.' });

        const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, sym) - mempool.getPendingUsdSpend(uid);
        const availableToken = nexusChain.getBalance(uid, sym) - menuBook.getLockedToken(uid, sym) - mempool.getPendingTokenSpend(uid, sym);

        if (side === 'BUY' && availableUsd < parsedAmount * parsedPrice)
            return res.status(400).json({ error: `Insufficient USD. Available: $${availableUsd.toFixed(4)}` });

        if (side === 'SELL' && availableToken < parsedAmount)
            return res.status(400).json({ error: `Insufficient ${sym}. Available: ${availableToken}` });

        const order = menuBook.placeLimitOrder(uid, sym, side, parsedAmount, parsedPrice);
        res.json({ success: true, orderId: order.id });
    } catch (e) {
        console.error(chalk.red('[Order] Limit order error:'), e.message);
        res.status(500).json({ error: 'Failed to place limit order.' });
    }
});

app.post('/order/cancel', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { orderId, ticker } = req.body;
        const uid = req.web3Address;
        const sym = ticker?.toUpperCase();

        const cancelled = menuBook.cancelOrder(uid, sym, orderId);
        if (!cancelled) return res.status(404).json({ error: 'Order not found or already filled.' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to cancel order.' });
    }
});

app.get('/orders/:uid', readLimiter, (req, res) => {
    try {
        const orders = menuBook.getUserOrders(req.params.uid);
        res.json(orders);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch orders.' });
    }
});

// ─── Transactions ─────────────────────────────────────────────────────────────
app.post('/tx/new', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { to, amount, tokenSymbol, memo } = req.body;
        const from = req.web3Address;

        if (!to || !amount || !tokenSymbol)
            return res.status(400).json({ error: 'Missing fields.' });

        const sym = tokenSymbol.toUpperCase();
        const parsedAmount = parseFloat(amount);

        if (parsedAmount <= 0) return res.status(400).json({ error: 'Amount must be positive.' });

        // Check system handler restrictions
        const handlerRow = await pool.query('SELECT system_address, token_symbol FROM system_handlers WHERE system_address = $1', [to]);
        if (handlerRow.rows.length > 0 && handlerRow.rows[0].token_symbol !== sym) {
            return res.status(400).json({ error: `This system address only accepts ${handlerRow.rows[0].token_symbol}.` });
        }

        let available;
        if (sym === 'USD') {
            available = nexusChain.state.getUsd(from) - mempool.getPendingUsdSpend(from);
        } else {
            available = nexusChain.getBalance(from, sym) - mempool.getPendingTokenSpend(from, sym);
        }

        if (available < parsedAmount)
            return res.status(400).json({ error: `Insufficient balance. Available: ${available}` });

        const tx = {
            from, to,
            amount: parsedAmount,
            type: 'TRANSFER',
            tokenSymbol: sym,
            timestamp: Date.now(),
            memo: memo || ''
        };

        const txId = mempool.addTransaction(tx);
        res.json({ success: true, txId });
    } catch (e) {
        console.error(chalk.red('[TX] New transaction error:'), e.message);
        res.status(500).json({ error: 'Failed to submit transaction.' });
    }
});

// ─── Mining Control ───────────────────────────────────────────────────────────
app.post('/mining/start', txLimiter, requireWeb3Auth, async (req, res) => {
    const uid = req.web3Address;
    if (uid !== 'system' && uid !== config.admin?.uid)
        return res.status(403).json({ error: 'Unauthorized.' });

    isMining = true;
    await saveApiState();
    res.json({ success: true, isMining });
});

app.post('/mining/stop', txLimiter, requireWeb3Auth, async (req, res) => {
    const uid = req.web3Address;
    if (uid !== 'system' && uid !== config.admin?.uid)
        return res.status(403).json({ error: 'Unauthorized.' });

    isMining = false;
    await saveApiState();
    res.json({ success: true, isMining });
});

// ─── Mint New Token ───────────────────────────────────────────────────────────
app.post('/mint-new-cash', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker, totalSupply, websiteUrl } = req.body;
        const uid = req.web3Address;

        if (!ticker || !totalSupply || !websiteUrl)
            return res.status(400).json({ error: 'Missing fields.' });

        const sym = ticker.toUpperCase();

        // Check domain verification
        const verifRow = await pool.query(
            "SELECT * FROM domain_verifications WHERE uid = $1 AND website_url = $2 AND status = 'verified'",
            [uid, websiteUrl]
        );
        if (verifRow.rows.length === 0)
            return res.status(403).json({ error: 'Domain not verified. Please verify domain first.' });

        // Check ticker not already taken
        if (nexusChain.state.balances[sym])
            return res.status(409).json({ error: `Token ${sym} already exists.` });

        const parsedSupply = parseFloat(totalSupply);
        if (parsedSupply <= 0) return res.status(400).json({ error: 'Invalid supply.' });

        const mintTx = {
            from: 'system',
            to: uid,
            amount: parsedSupply,
            type: 'MINT',
            tokenSymbol: sym,
            timestamp: Date.now(),
            isSystemGenerated: true
        };

        await nexusChain.addBlock([mintTx], currentPrice);

        // Mark verification as used
        await pool.query(
            "UPDATE domain_verifications SET status = 'used' WHERE id = $1",
            [verifRow.rows[0].id]
        );

        // Init liquidity pool
        nexusChain.state.initPool(sym);

        res.json({ success: true, ticker: sym, supply: parsedSupply, owner: uid });
    } catch (e) {
        console.error(chalk.red('[Mint] Error:'), e.message);
        res.status(500).json({ error: 'Mint failed.' });
    }
});

// ─── System Handler ───────────────────────────────────────────────────────────
app.post('/system-handler/pay-fee', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker } = req.body;
        const uid = req.web3Address;

        if (!ticker) return res.status(400).json({ error: 'Ticker required.' });
        const sym = ticker.toUpperCase();

        // Verify caller is token creator (has MINT tx to them)
        const mintRow = await pool.query(
            `SELECT to_address FROM transactions
             WHERE type = 'MINT' AND token_symbol = $1 AND is_system_generated = TRUE
             ORDER BY timestamp_ms ASC LIMIT 1`,
            [sym]
        );
        if (mintRow.rows.length === 0 || mintRow.rows[0].to_address !== uid)
            return res.status(403).json({ error: 'Only the token creator can activate a system handler.' });

        // Check existing handler
        const existingHandler = await pool.query('SELECT * FROM system_handlers WHERE token_symbol = $1', [sym]);
        if (existingHandler.rows.length > 0)
            return res.status(409).json({ error: 'System handler already exists for this token.' });

        // Charge $2 fee
        const FEE = 2.0;
        const usdBalance = nexusChain.state.getUsd(uid);
        if (usdBalance < FEE)
            return res.status(400).json({ error: `Insufficient USD. Need $${FEE}, have $${usdBalance.toFixed(4)}` });

        if (!nexusChain.state.deductUsd(uid, FEE))
            return res.status(400).json({ error: 'Failed to deduct fee.' });

        // Generate deterministic system address
        const systemAddress = `sys-${sym.toLowerCase()}-${crypto.createHash('sha256').update(uid + sym).digest('hex').slice(0, 12)}`;

        await pool.query(
            'INSERT INTO system_handlers (token_symbol, system_address, creator_uid, created_at) VALUES ($1, $2, $3, $4)',
            [sym, systemAddress, uid, Date.now()]
        );

        res.json({
            success: true,
            systemAddress,
            message: `System Handler activated for ${ticker}. Fee of $2.00 deducted (will apply after next block).`
        });
    } catch (e) {
        console.error(chalk.red('[SYSTEM HANDLER] pay-fee error:'), e.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── PayPal Integration ───────────────────────────────────────────────────────
app.post('/paypal/create-order', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { amount } = req.body;
        const parsedAmount = parseFloat(amount);

        if (!parsedAmount || parsedAmount < 1 || parsedAmount > 10000)
            return res.status(400).json({ error: 'Amount must be between $1 and $10,000.' });

        const accessToken = await getPayPalAccessToken();

        const orderRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: {
                        currency_code: 'USD',
                        value: parsedAmount.toFixed(2)
                    },
                    description: `DataChain USD Deposit - ${req.web3Address}`
                }]
            })
        });

        const order = await orderRes.json();
        if (!order.id) throw new Error('PayPal order creation failed');

        res.json({ orderId: order.id });
    } catch (e) {
        console.error(chalk.red('[PayPal] Create order error:'), e.message);
        res.status(500).json({ error: 'Failed to create PayPal order.' });
    }
});

app.post('/paypal/capture-order', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { orderId } = req.body;
        const uid = req.web3Address;

        const accessToken = await getPayPalAccessToken();

        const captureRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        const capture = await captureRes.json();
        if (capture.status !== 'COMPLETED') throw new Error('PayPal capture not completed');

        const capturedAmount = parseFloat(
            capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || 0
        );

        if (capturedAmount <= 0) throw new Error('Invalid captured amount');

        // Credit USD to user account
        nexusChain.state.addUsd(uid, capturedAmount);

        // Record transaction
        const depositTx = {
            from: 'paypal-gateway',
            to: uid,
            amount: capturedAmount,
            type: 'DEPOSIT',
            tokenSymbol: 'USD',
            timestamp: Date.now(),
            isSystemGenerated: true,
            description: `PayPal deposit - Order ${orderId}`
        };
        await nexusChain.addBlock([depositTx], currentPrice);

        global.broadcastWS('USD_DEPOSITED', { uid, amount: capturedAmount });
        res.json({ success: true, amount: capturedAmount });
    } catch (e) {
        console.error(chalk.red('[PayPal] Capture error:'), e.message);
        res.status(500).json({ error: 'Failed to capture PayPal payment.' });
    }
});

// ─── Market Trading ───────────────────────────────────────────────────────────
app.post('/trade/buy', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker, usdAmount } = req.body;
        const uid = req.web3Address;

        if (!ticker || !usdAmount) return res.status(400).json({ error: 'Missing fields.' });

        const sym = ticker.toUpperCase();
        const parsedUsd = parseFloat(usdAmount);

        if (parsedUsd <= 0) return res.status(400).json({ error: 'USD amount must be positive.' });

        const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, sym) - mempool.getPendingUsdSpend(uid);
        if (availableUsd < parsedUsd)
            return res.status(400).json({ error: `Insufficient USD. Available: $${availableUsd.toFixed(4)}` });

        const poolPrice = nexusChain.state.getPoolPrice(sym) || currentPrice;
        const tokenAmount = parsedUsd / poolPrice;

        if (!nexusChain.state.deductUsd(uid, parsedUsd))
            return res.status(400).json({ error: 'Failed to deduct USD.' });

        if (!nexusChain.state.balances[sym]) nexusChain.state.balances[sym] = {};
        nexusChain.state.balances[sym][uid] = (nexusChain.state.balances[sym][uid] || 0) + tokenAmount;

        const tradeTx = {
            from: uid,
            to: uid,
            amount: tokenAmount,
            amountUsd: parsedUsd,
            type: 'MARKET_TRADE',
            tokenSymbol: sym,
            side: 'BUY',
            timestamp: Date.now()
        };
        await nexusChain.addBlock([tradeTx], poolPrice);

        global.broadcastWS('TRADE_EXECUTED', { uid, ticker: sym, side: 'BUY', tokenAmount, usdAmount: parsedUsd, price: poolPrice });
        res.json({ success: true, tokenAmount, price: poolPrice });
    } catch (e) {
        console.error(chalk.red('[Trade] Buy error:'), e.message);
        res.status(500).json({ error: 'Trade failed.' });
    }
});

app.post('/trade/sell', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker, tokenAmount } = req.body;
        const uid = req.web3Address;

        if (!ticker || !tokenAmount) return res.status(400).json({ error: 'Missing fields.' });

        const sym = ticker.toUpperCase();
        const parsedAmount = parseFloat(tokenAmount);

        if (parsedAmount <= 0) return res.status(400).json({ error: 'Amount must be positive.' });

        const availableToken = nexusChain.getBalance(uid, sym) - menuBook.getLockedToken(uid, sym) - mempool.getPendingTokenSpend(uid, sym);
        if (availableToken < parsedAmount)
            return res.status(400).json({ error: `Insufficient ${sym}. Available: ${availableToken}` });

        const poolPrice = nexusChain.state.getPoolPrice(sym) || currentPrice;
        const usdReceived = parsedAmount * poolPrice;

        nexusChain.state.balances[sym][uid] = Math.max(0, (nexusChain.state.balances[sym][uid] || 0) - parsedAmount);
        nexusChain.state.addUsd(uid, usdReceived);

        const tradeTx = {
            from: uid,
            to: uid,
            amount: parsedAmount,
            amountUsd: usdReceived,
            type: 'MARKET_TRADE',
            tokenSymbol: sym,
            side: 'SELL',
            timestamp: Date.now()
        };
        await nexusChain.addBlock([tradeTx], poolPrice);

        global.broadcastWS('TRADE_EXECUTED', { uid, ticker: sym, side: 'SELL', tokenAmount: parsedAmount, usdAmount: usdReceived, price: poolPrice });
        res.json({ success: true, usdReceived, price: poolPrice });
    } catch (e) {
        console.error(chalk.red('[Trade] Sell error:'), e.message);
        res.status(500).json({ error: 'Trade failed.' });
    }
});

// ─── Positions ────────────────────────────────────────────────────────────────
app.get('/positions/:uid', readLimiter, async (req, res) => {
    try {
        const uid = req.params.uid;
        const positions = [];

        for (const ticker in nexusChain.state.balances) {
            const bal = nexusChain.state.getBalance(uid, ticker);
            if (bal > 0) {
                const price = ticker === 'SYR' ? currentPrice : (nexusChain.state.getPoolPrice(ticker) || 0.01);
                positions.push({ ticker, balance: bal, price, valueUsd: bal * price });
            }
        }

        res.json({ uid, positions, usdBalance: nexusChain.state.getUsd(uid) });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch positions.' });
    }
});

// ─── Liquidity Pools ──────────────────────────────────────────────────────────
app.get('/pools', readLimiter, (req, res) => {
    try {
        const pools = [];
        for (const ticker in nexusChain.state.liquidityPools) {
            const lp = nexusChain.state.liquidityPools[ticker];
            pools.push({
                ticker,
                tokenReserve: lp.tokenReserve,
                usdReserve: lp.usdReserve,
                price: lp.usdReserve / lp.tokenReserve || 0
            });
        }
        res.json(pools);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch pools.' });
    }
});

app.post('/pool/add-liquidity', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker, tokenAmount, usdAmount } = req.body;
        const uid = req.web3Address;

        if (!ticker || !tokenAmount || !usdAmount) return res.status(400).json({ error: 'Missing fields.' });

        const sym = ticker.toUpperCase();
        const parsedToken = parseFloat(tokenAmount);
        const parsedUsd = parseFloat(usdAmount);

        if (parsedToken <= 0 || parsedUsd <= 0) return res.status(400).json({ error: 'Invalid amounts.' });

        const availableUsd = nexusChain.state.getUsd(uid);
        const availableToken = nexusChain.getBalance(uid, sym);

        if (availableUsd < parsedUsd) return res.status(400).json({ error: `Insufficient USD.` });
        if (availableToken < parsedToken) return res.status(400).json({ error: `Insufficient ${sym}.` });

        nexusChain.state.deductUsd(uid, parsedUsd);
        nexusChain.state.balances[sym][uid] = Math.max(0, (nexusChain.state.balances[sym][uid] || 0) - parsedToken);

        if (!nexusChain.state.liquidityPools[sym]) nexusChain.state.initPool(sym);
        nexusChain.state.liquidityPools[sym].tokenReserve += parsedToken;
        nexusChain.state.liquidityPools[sym].usdReserve += parsedUsd;

        res.json({ success: true, ticker: sym, tokenAdded: parsedToken, usdAdded: parsedUsd });
    } catch (e) {
        res.status(500).json({ error: 'Failed to add liquidity.' });
    }
});

// ─── Staking ──────────────────────────────────────────────────────────────────
app.post('/stake', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { amount } = req.body;
        const uid = req.web3Address;
        const parsedAmount = parseFloat(amount);

        if (!parsedAmount || parsedAmount <= 0) return res.status(400).json({ error: 'Invalid amount.' });

        const available = nexusChain.getBalance(uid, 'SYR') - mempool.getPendingTokenSpend(uid, 'SYR');
        if (available < parsedAmount) return res.status(400).json({ error: `Insufficient SYR. Available: ${available}` });

        const stakeTx = {
            from: uid,
            to: 'staking-pool',
            amount: parsedAmount,
            type: 'STAKE',
            tokenSymbol: 'SYR',
            timestamp: Date.now()
        };

        mempool.addTransaction(stakeTx);
        res.json({ success: true, staked: parsedAmount });
    } catch (e) {
        res.status(500).json({ error: 'Staking failed.' });
    }
});

app.post('/unstake', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { amount } = req.body;
        const uid = req.web3Address;
        const parsedAmount = parseFloat(amount);

        if (!parsedAmount || parsedAmount <= 0) return res.status(400).json({ error: 'Invalid amount.' });

        const stakedBalance = nexusChain.getBalance(uid, 'SYR-STAKED') || 0;
        if (stakedBalance < parsedAmount) return res.status(400).json({ error: `Insufficient staked SYR. Staked: ${stakedBalance}` });

        const unstakeTx = {
            from: 'staking-pool',
            to: uid,
            amount: parsedAmount,
            type: 'UNSTAKE',
            tokenSymbol: 'SYR',
            timestamp: Date.now(),
            isSystemGenerated: true
        };

        await nexusChain.addBlock([unstakeTx], currentPrice);
        res.json({ success: true, unstaked: parsedAmount });
    } catch (e) {
        res.status(500).json({ error: 'Unstaking failed.' });
    }
});

// ─── Swap ─────────────────────────────────────────────────────────────────────
app.post('/swap', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { fromToken, toToken, amount } = req.body;
        const uid = req.web3Address;

        if (!fromToken || !toToken || !amount) return res.status(400).json({ error: 'Missing fields.' });

        const fromSym = fromToken.toUpperCase();
        const toSym = toToken.toUpperCase();
        const parsedAmount = parseFloat(amount);

        if (parsedAmount <= 0) return res.status(400).json({ error: 'Amount must be positive.' });
        if (fromSym === toSym) return res.status(400).json({ error: 'Cannot swap same token.' });

        const fromBalance = fromSym === 'USD' ? nexusChain.state.getUsd(uid) : nexusChain.getBalance(uid, fromSym);
        if (fromBalance < parsedAmount) return res.status(400).json({ error: `Insufficient ${fromSym}.` });

        const fromPrice = fromSym === 'USD' ? 1 : (nexusChain.state.getPoolPrice(fromSym) || 0.01);
        const toPrice = toSym === 'USD' ? 1 : (nexusChain.state.getPoolPrice(toSym) || 0.01);

        const fromUsdValue = parsedAmount * fromPrice;
        const toAmount = fromUsdValue / toPrice;

        // Deduct from
        if (fromSym === 'USD') {
            nexusChain.state.deductUsd(uid, parsedAmount);
        } else {
            nexusChain.state.balances[fromSym][uid] = Math.max(0, (nexusChain.state.balances[fromSym][uid] || 0) - parsedAmount);
        }

        // Add to
        if (toSym === 'USD') {
            nexusChain.state.addUsd(uid, toAmount);
        } else {
            if (!nexusChain.state.balances[toSym]) nexusChain.state.balances[toSym] = {};
            nexusChain.state.balances[toSym][uid] = (nexusChain.state.balances[toSym][uid] || 0) + toAmount;
        }

        const swapTx = {
            from: uid,
            to: uid,
            amount: parsedAmount,
            amountUsd: fromUsdValue,
            type: 'SWAP',
            tokenSymbol: fromSym,
            toTokenSymbol: toSym,
            timestamp: Date.now()
        };
        await nexusChain.addBlock([swapTx], currentPrice);

        res.json({ success: true, fromAmount: parsedAmount, toAmount, fromToken: fromSym, toToken: toSym });
    } catch (e) {
        console.error(chalk.red('[Swap] Error:'), e.message);
        res.status(500).json({ error: 'Swap failed.' });
    }
});

// ─── Token Verification Status ────────────────────────────────────────────────
app.post('/token/verify', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker } = req.body;
        const sym = ticker?.toUpperCase();
        if (!sym) return res.status(400).json({ error: 'Ticker required.' });

        const existing = await pool.query('SELECT * FROM token_verifications WHERE ticker = $1', [sym]);
        if (existing.rows.length > 0 && existing.rows[0].is_verified)
            return res.json({ verified: true, ticker: sym });

        const code = crypto.randomBytes(8).toString('hex');
        await pool.query(
            'INSERT INTO token_verifications (ticker, verification_code) VALUES ($1, $2) ON CONFLICT (ticker) DO UPDATE SET verification_code = $2',
            [sym, code]
        );

        res.json({ verified: false, ticker: sym, verificationCode: code, instructions: `Add TXT record: datachain-verify=${code}` });
    } catch (e) {
        res.status(500).json({ error: 'Verification failed.' });
    }
});

app.post('/token/confirm-verify', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker } = req.body;
        const sym = ticker?.toUpperCase();
        if (!sym) return res.status(400).json({ error: 'Ticker required.' });

        // In production, do actual DNS lookup
        await pool.query(
            'UPDATE token_verifications SET is_verified = TRUE WHERE ticker = $1',
            [sym]
        );

        res.json({ success: true, verified: true, ticker: sym });
    } catch (e) {
        res.status(500).json({ error: 'Confirmation failed.' });
    }
});

// ─── Mempool ──────────────────────────────────────────────────────────────────
app.get('/mempool', readLimiter, (req, res) => {
    try {
        const pending = mempool.getPendingTransactions();
        res.json({ count: pending.length, transactions: pending.slice(0, 50) });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch mempool.' });
    }
});

// ─── Validator ────────────────────────────────────────────────────────────────
app.post('/validate', txLimiter, async (req, res) => {
    try {
        const result = validator.validate(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: 'Validation failed.' });
    }
});

// ─── Email Notifications ──────────────────────────────────────────────────────
app.post('/notify/email', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { to, subject, body } = req.body;
        if (!to || !subject || !body) return res.status(400).json({ error: 'Missing fields.' });

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text: body });
        res.json({ success: true });
    } catch (e) {
        console.error(chalk.red('[Email] Send error:'), e.message);
        res.status(500).json({ error: 'Failed to send email.' });
    }
});

// ─── Explorer ─────────────────────────────────────────────────────────────────
app.get('/explorer/search/:query', readLimiter, async (req, res) => {
    try {
        const q = req.params.query;

        // Try block index
        if (/^\d+$/.test(q)) {
            const blockRes = await pool.query('SELECT * FROM blocks WHERE block_index = $1', [parseInt(q)]);
            if (blockRes.rows.length > 0) return res.json({ type: 'block', data: blockRes.rows[0] });
        }

        // Try tx hash
        const txRes = await pool.query('SELECT * FROM transactions WHERE tx_hash = $1', [q]);
        if (txRes.rows.length > 0) return res.json({ type: 'transaction', data: txRes.rows[0] });

        // Try address
        const balances = {};
        for (const ticker in nexusChain.state.balances) {
            const bal = nexusChain.state.getBalance(q, ticker);
            if (bal > 0) balances[ticker] = bal;
        }
        if (Object.keys(balances).length > 0) {
            return res.json({ type: 'address', data: { address: q, balances, usdBalance: nexusChain.state.getUsd(q) } });
        }

        res.status(404).json({ error: 'Not found.' });
    } catch (e) {
        res.status(500).json({ error: 'Explorer search failed.' });
    }
});

// ─── Statistics ───────────────────────────────────────────────────────────────
app.get('/stats', readLimiter, async (req, res) => {
    try {
        const txCountRes = await pool.query('SELECT COUNT(*) as count FROM transactions');
        const blockCountRes = await pool.query('SELECT COUNT(*) as count FROM blocks');
        const uniqueAddressesRes = await pool.query(
            'SELECT COUNT(DISTINCT from_address) + COUNT(DISTINCT to_address) as count FROM transactions'
        );

        res.json({
            totalTransactions: parseInt(txCountRes.rows[0].count),
            totalBlocks: parseInt(blockCountRes.rows[0].count),
            uniqueAddresses: parseInt(uniqueAddressesRes.rows[0].count),
            currentPrice,
            isMining,
            chainLength: nexusChain.blockCount
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// ─── Leaderboard ──────────────────────────────────────────────────────────────
app.get('/leaderboard', readLimiter, async (req, res) => {
    try {
        const { ticker = 'SYR', limit = 20 } = req.query;
        const sym = ticker.toUpperCase();
        const tokenBalances = nexusChain.state.balances[sym] || {};

        const entries = Object.entries(tokenBalances)
            .filter(([addr, bal]) => bal > 0 && addr !== 'system' && addr !== 'staking-pool')
            .sort(([, a], [, b]) => b - a)
            .slice(0, parseInt(limit))
            .map(([address, balance]) => ({ address, balance }));

        res.json({ ticker: sym, leaderboard: entries });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch leaderboard.' });
    }
});

// ─── NFT Placeholder ──────────────────────────────────────────────────────────
app.get('/nft/list', readLimiter, (req, res) => {
    res.json({ nfts: [], message: 'NFT support coming soon.' });
});

// ─── Governance ───────────────────────────────────────────────────────────────
app.get('/governance/proposals', readLimiter, (req, res) => {
    res.json({ proposals: [], message: 'Governance module coming soon.' });
});

// ─── Token Price History ──────────────────────────────────────────────────────
app.get('/token/:ticker/price-history', readLimiter, async (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const { limit = 100, offset = 0 } = req.query;

        const result = await pool.query(
            `SELECT price, timestamp_ms FROM transactions
             WHERE token_symbol = $1 AND type IN ('MARKET_TRADE', 'SWAP')
             ORDER BY timestamp_ms DESC LIMIT $2 OFFSET $3`,
            [ticker, parseInt(limit), parseInt(offset)]
        );

        res.json(result.rows.reverse());
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch price history.' });
    }
});

// ─── Batch Balance Check ──────────────────────────────────────────────────────
app.post('/balances/batch', readLimiter, async (req, res) => {
    try {
        const { addresses } = req.body;
        if (!Array.isArray(addresses) || addresses.length > 100)
            return res.status(400).json({ error: 'Provide up to 100 addresses.' });

        const result = {};
        for (const addr of addresses) {
            result[addr] = {
                usd: nexusChain.state.getUsd(addr),
                tokens: {}
            };
            for (const ticker in nexusChain.state.balances) {
                const bal = nexusChain.state.getBalance(addr, ticker);
                if (bal > 0) result[addr].tokens[ticker] = bal;
            }
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: 'Batch balance check failed.' });
    }
});

// ─── Withdrawal (USD Off-ramp) ────────────────────────────────────────────────
app.post('/withdraw/usd', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { amount, paypalEmail } = req.body;
        const uid = req.web3Address;
        const parsedAmount = parseFloat(amount);

        if (!parsedAmount || parsedAmount < 5) return res.status(400).json({ error: 'Minimum withdrawal is $5.' });
        if (!paypalEmail) return res.status(400).json({ error: 'PayPal email required.' });

        const available = nexusChain.state.getUsd(uid);
        if (available < parsedAmount) return res.status(400).json({ error: `Insufficient USD. Available: $${available.toFixed(4)}` });

        // Deduct and record (payout handled manually or via PayPal Payouts API)
        nexusChain.state.deductUsd(uid, parsedAmount);

        const withdrawTx = {
            from: uid,
            to: 'withdrawal-pool',
            amount: parsedAmount,
            type: 'WITHDRAWAL',
            tokenSymbol: 'USD',
            timestamp: Date.now(),
            description: `Withdrawal to PayPal: ${paypalEmail}`
        };
        await nexusChain.addBlock([withdrawTx], currentPrice);

        res.json({ success: true, amount: parsedAmount, message: 'Withdrawal queued. Funds will arrive within 1-3 business days.' });
    } catch (e) {
        console.error(chalk.red('[Withdraw] Error:'), e.message);
        res.status(500).json({ error: 'Withdrawal failed.' });
    }
});

// ─── System Handler Info ──────────────────────────────────────────────────────
app.get('/system-handler/:ticker', readLimiter, async (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const result = await pool.query('SELECT * FROM system_handlers WHERE token_symbol = $1', [ticker]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'No system handler for this token.' });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch system handler.' });
    }
});

// ============================================================
// P2P MARKETPLACE ENDPOINTS
// ============================================================

app.get('/p2p/offers', readLimiter, async (req, res) => {
    try {
        const { asset, pay_method, min_amount, max_amount, limit = 50, offset = 0 } = req.query;
        let query = `SELECT * FROM p2p_offers WHERE status = 'OPEN'`;
        const params = [];
        let idx = 1;
        if (asset) { query += ` AND asset_symbol = $${idx++}`; params.push(asset.toUpperCase()); }
        if (pay_method) { query += ` AND pay_method = $${idx++}`; params.push(pay_method); }
        if (min_amount) { query += ` AND amount >= $${idx++}`; params.push(parseFloat(min_amount)); }
        if (max_amount) { query += ` AND amount <= $${idx++}`; params.push(parseFloat(max_amount)); }
        query += ` ORDER BY merchant_rating DESC, created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
        params.push(parseInt(limit), parseInt(offset));
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (e) {
        console.error('[P2P] Get offers error', e);
        res.status(500).json({ error: 'Failed to fetch offers' });
    }
});

app.post('/p2p/post-offer', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { asset_symbol, amount, rate, currency = 'USD', pay_method, pay_details } = req.body;
        const merchantAddress = req.web3Address;
        if (!asset_symbol || !amount || !rate || !pay_method) return res.status(400).json({ error: 'Missing required fields' });
        const sym = asset_symbol.toUpperCase();
        if (!['SDX', 'SDTX'].includes(sym)) return res.status(400).json({ error: 'Only SDX and SDTX supported for P2P' });
        const parsedAmount = parseFloat(amount);
        if (parsedAmount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
        // Check merchant has sufficient balance
        let balance = 0;
        if (sym === 'SDX') {
            balance = nexusChain.state.getUsd(merchantAddress);
        } else {
            balance = nexusChain.getBalance(merchantAddress, sym);
        }
        if (balance < parsedAmount) return res.status(400).json({ error: `Insufficient ${sym} balance. Have: ${balance}, Need: ${parsedAmount}` });
        // Lock funds
        if (sym === 'SDX') {
            if (!nexusChain.state.deductUsd(merchantAddress, parsedAmount)) return res.status(400).json({ error: 'Failed to lock SDX' });
        } else {
            const lockTx = { from: merchantAddress, to: 'p2p-escrow', amount: parsedAmount, type: 'TRANSFER', tokenSymbol: sym, timestamp: Date.now() };
            if (!nexusChain.state.applyTransaction(lockTx, 1, false)) return res.status(400).json({ error: 'Failed to lock ' + sym });
        }
        const result = await pool.query(
            `INSERT INTO p2p_offers (merchant_address, asset_symbol, amount, amount_locked, rate, currency, pay_method, pay_details, status, created_at)
             VALUES ($1, $2, $3, $3, $4, $5, $6, $7, 'OPEN', $8) RETURNING *`,
            [merchantAddress, sym, parsedAmount, parseFloat(rate), currency, pay_method, pay_details || '', Date.now()]
        );
        res.json({ success: true, offer: result.rows[0] });
    } catch (e) {
        console.error('[P2P] Post offer error', e);
        res.status(500).json({ error: 'Failed to post offer' });
    }
});

app.post('/p2p/cancel-offer', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { offer_id } = req.body;
        const merchantAddress = req.web3Address;
        const offerRes = await pool.query(`SELECT * FROM p2p_offers WHERE id = $1 AND merchant_address = $2 AND status = 'OPEN'`, [offer_id, merchantAddress]);
        if (offerRes.rows.length === 0) return res.status(404).json({ error: 'Offer not found or not cancellable' });
        const offer = offerRes.rows[0];
        // Unlock funds
        if (offer.asset_symbol === 'SDX') {
            nexusChain.state.addUsd(merchantAddress, parseFloat(offer.amount_locked));
        } else {
            if (!nexusChain.state.balances[offer.asset_symbol]) nexusChain.state.balances[offer.asset_symbol] = {};
            const escrow = nexusChain.state.balances[offer.asset_symbol]['p2p-escrow'] || 0;
            nexusChain.state.balances[offer.asset_symbol]['p2p-escrow'] = Math.max(0, escrow - parseFloat(offer.amount_locked));
            nexusChain.state.balances[offer.asset_symbol][merchantAddress] = (nexusChain.state.balances[offer.asset_symbol][merchantAddress] || 0) + parseFloat(offer.amount_locked);
        }
        await pool.query(`UPDATE p2p_offers SET status = 'CANCELLED' WHERE id = $1`, [offer_id]);
        res.json({ success: true });
    } catch (e) {
        console.error('[P2P] Cancel offer error', e);
        res.status(500).json({ error: 'Failed to cancel offer' });
    }
});

app.post('/p2p/initiate-trade', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { offer_id, amount } = req.body;
        const buyerAddress = req.web3Address;
        const offerRes = await pool.query(`SELECT * FROM p2p_offers WHERE id = $1 AND status = 'OPEN'`, [offer_id]);
        if (offerRes.rows.length === 0) return res.status(404).json({ error: 'Offer not found or already taken' });
        const offer = offerRes.rows[0];
        if (buyerAddress === offer.merchant_address) return res.status(400).json({ error: 'Cannot trade with yourself' });
        const tradeAmount = parseFloat(amount) || parseFloat(offer.amount);
        if (tradeAmount > parseFloat(offer.amount)) return res.status(400).json({ error: 'Amount exceeds offer size' });
        // Mark offer as locked
        await pool.query(`UPDATE p2p_offers SET status = 'LOCKED' WHERE id = $1`, [offer_id]);
        const now = Date.now();
        const tradeRes = await pool.query(
            `INSERT INTO p2p_trades (offer_id, buyer_address, merchant_address, asset_symbol, amount, rate, currency, pay_method, pay_details, status, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10,$10) RETURNING *`,
            [offer_id, buyerAddress, offer.merchant_address, offer.asset_symbol, tradeAmount, offer.rate, offer.currency, offer.pay_method, offer.pay_details, now]
        );
        res.json({ success: true, trade: tradeRes.rows[0] });
    } catch (e) {
        console.error('[P2P] Initiate trade error', e);
        res.status(500).json({ error: 'Failed to initiate trade' });
    }
});

app.get('/p2p/trade/:id', readLimiter, async (req, res) => {
    try {
        const result = await pool.query(`SELECT t.*, o.pay_details FROM p2p_trades t LEFT JOIN p2p_offers o ON t.offer_id = o.id WHERE t.id = $1`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch trade' });
    }
});

app.post('/p2p/mark-paid', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { trade_id } = req.body;
        const buyerAddress = req.web3Address;
        const result = await pool.query(`SELECT * FROM p2p_trades WHERE id=$1 AND buyer_address=$2 AND status='PENDING'`, [trade_id, buyerAddress]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found or not in PENDING state' });
        await pool.query(`UPDATE p2p_trades SET status='PAID', updated_at=$1 WHERE id=$2`, [Date.now(), trade_id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to mark as paid' });
    }
});

app.post('/p2p/release-funds', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { trade_id } = req.body;
        const merchantAddress = req.web3Address;
        const tradeRes = await pool.query(`SELECT * FROM p2p_trades WHERE id=$1 AND merchant_address=$2 AND status='PAID'`, [trade_id, merchantAddress]);
        if (tradeRes.rows.length === 0) return res.status(404).json({ error: 'Trade not found or buyer has not marked payment' });
        const trade = tradeRes.rows[0];
        const tradeAmount = parseFloat(trade.amount);
        const sym = trade.asset_symbol;
        // Transfer from escrow to buyer
        if (sym === 'SDX') {
            nexusChain.state.addUsd(trade.buyer_address, tradeAmount);
        } else {
            if (!nexusChain.state.balances[sym]) nexusChain.state.balances[sym] = {};
            const escrow = nexusChain.state.balances[sym]['p2p-escrow'] || 0;
            nexusChain.state.balances[sym]['p2p-escrow'] = Math.max(0, escrow - tradeAmount);
            nexusChain.state.balances[sym][trade.buyer_address] = (nexusChain.state.balances[sym][trade.buyer_address] || 0) + tradeAmount;
        }
        await pool.query(`UPDATE p2p_trades SET status='RELEASED', updated_at=$1 WHERE id=$2`, [Date.now(), trade_id]);
        await pool.query(`UPDATE p2p_offers SET status='COMPLETED', trade_count = trade_count + 1 WHERE id=$1`, [trade.offer_id]);
        // Record on-chain
        const chainTx = { from: 'p2p-escrow', to: trade.buyer_address, amount: tradeAmount, type: 'TRANSFER', tokenSymbol: sym, timestamp: Date.now(), isSystemGenerated: true, description: `P2P Trade #${trade_id}` };
        await nexusChain.addBlock([chainTx], 1.0);
        if (global.broadcastWS) global.broadcastWS('P2P_TRADE_COMPLETED', { tradeId: trade_id, buyer: trade.buyer_address, amount: tradeAmount, asset: sym });
        res.json({ success: true });
    } catch (e) {
        console.error('[P2P] Release funds error', e);
        res.status(500).json({ error: 'Failed to release funds' });
    }
});

app.post('/p2p/dispute', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { trade_id, reason } = req.body;
        const callerAddress = req.web3Address;
        const result = await pool.query(
            `SELECT * FROM p2p_trades WHERE id=$1 AND (buyer_address=$2 OR merchant_address=$2) AND status IN ('PENDING','PAID')`,
            [trade_id, callerAddress]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found or cannot be disputed' });
        await pool.query(`UPDATE p2p_trades SET status='DISPUTED', dispute_reason=$1, updated_at=$2 WHERE id=$3`, [reason || '', Date.now(), trade_id]);
        res.json({ success: true, message: 'Dispute filed. Admin will review within 24 hours.' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to file dispute' });
    }
});

app.get('/p2p/my-trades', readLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const address = req.web3Address;
        const result = await pool.query(
            `SELECT * FROM p2p_trades WHERE buyer_address=$1 OR merchant_address=$1 ORDER BY updated_at DESC LIMIT 100`,
            [address]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch trades' });
    }
});

app.post('/p2p/rate-trade', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { trade_id, rating } = req.body;
        const callerAddress = req.web3Address;
        const parsedRating = parseInt(rating);
        if (parsedRating < 1 || parsedRating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
        const tradeRes = await pool.query(`SELECT * FROM p2p_trades WHERE id=$1 AND status='RELEASED'`, [trade_id]);
        if (tradeRes.rows.length === 0) return res.status(404).json({ error: 'Trade not found or not completed' });
        const trade = tradeRes.rows[0];
        let updateField, ratedAddress;
        if (callerAddress === trade.buyer_address) {
            updateField = 'merchant_rating_val';
            ratedAddress = trade.merchant_address;
        } else if (callerAddress === trade.merchant_address) {
            updateField = 'buyer_rating';
            ratedAddress = trade.buyer_address;
        } else {
            return res.status(403).json({ error: 'Not a party to this trade' });
        }
        await pool.query(`UPDATE p2p_trades SET ${updateField}=$1 WHERE id=$2`, [parsedRating, trade_id]);
        // Update merchant average rating
        const avgRes = await pool.query(`SELECT AVG(merchant_rating_val) as avg FROM p2p_trades WHERE merchant_address=$1 AND merchant_rating_val IS NOT NULL`, [trade.merchant_address]);
        if (avgRes.rows[0].avg) {
            await pool.query(`UPDATE p2p_offers SET merchant_rating=$1 WHERE merchant_address=$2`, [parseFloat(avgRes.rows[0].avg), trade.merchant_address]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to rate trade' });
    }
});

app.get('/p2p/merchant/:address', readLimiter, async (req, res) => {
    try {
        const { address } = req.params;
        const offersRes = await pool.query(`SELECT * FROM p2p_offers WHERE merchant_address=$1 AND status='OPEN'`, [address]);
        const statsRes = await pool.query(`SELECT AVG(merchant_rating_val) as avg_rating, COUNT(*) as trade_count FROM p2p_trades WHERE merchant_address=$1 AND status='RELEASED'`, [address]);
        res.json({
            address,
            rating: parseFloat(statsRes.rows[0].avg_rating) || 5.0,
            tradeCount: parseInt(statsRes.rows[0].trade_count) || 0,
            activeOffers: offersRes.rows
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch merchant profile' });
    }
});

// ─── Debug: Token Owner Check ────────────────────────────────────────────────
// Authenticated: returns the exact owner address stored in DB for a token.
// Lets the creator compare their wallet address against what the DB holds.
app.get('/debug/owner/:ticker', readLimiter, async (req, res) => {
    const ticker = String(req.params.ticker || '').toUpperCase();
    if (!ticker) return res.status(400).json({ error: 'Invalid ticker.' });
    try {
        const row = await pool.query(
            `SELECT to_address, from_address, timestamp_ms, is_system_generated
             FROM transactions
             WHERE type = 'MINT' AND token_symbol = $1 AND is_system_generated = TRUE
             ORDER BY timestamp_ms ASC LIMIT 1`,
            [ticker]
        );
        if (row.rows.length === 0) return res.json({ ticker, owner: null, message: 'No MINT transaction found in DB for this token.' });
        res.json({
            ticker,
            owner: row.rows[0].to_address,
            from: row.rows[0].from_address,
            timestamp: row.rows[0].timestamp_ms,
            isSystemGenerated: row.rows[0].is_system_generated
        });
    } catch (e) {
        res.status(500).json({ error: 'DB query failed.' });
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
