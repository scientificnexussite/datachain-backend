import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto'; 
import fs from 'fs';
import path from 'path';
import pool from './db.js'; // Issue #3 Fixed
import mempool from './mempool.js';
import { DataChain } from './datachain.js';
import validator from './validator.js';
import menuBook from './menubook.js'; 
import './p2p.js'; 
import config from './config.json' with { type: "json" };

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE = "https://api-m.paypal.com";

pool.query(`
    CREATE TABLE IF NOT EXISTS api_state (
        id VARCHAR(50) PRIMARY KEY,
        data JSONB
    );
`).catch(err => console.error(chalk.red("[DB] API State init failed"), err));

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || config.network.api_port;

const nexusChain = new DataChain();
let positionsCache = new Map(); 

app.use(helmet()); 

const allowedOrigins = [
    'https://scientific-nexus-site.vercel.app', 
    'https://scientific-nexus-data-chain.vercel.app', 
    'https://syrpts-terminal.vercel.app'
];

// Issue #1 Fixed: Strict CORS Enforcement
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

const txLimiter = rateLimit({
    windowMs: 60 * 1000, 
    max: 50, 
    keyGenerator: (req) => req.body?.uid || req.ip,
    message: { error: "Too many transactions submitted. Please try again later." }
});

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
    let seq = '02' + rLen + r + '02' + sLen + s;
    let seqLen = (seq.length / 2).toString(16).padStart(2, '0');
    return '30' + seqLen + seq;
};

const requireWeb3Auth = (req, res, next) => {
    const { signature, publicKey, uid, ...payloadData } = req.body;
    if (!signature || !publicKey || !uid) return res.status(401).json({ error: "Unauthorized: Missing Web3 ECDSA Signature." });
    
    try {
        const verify = crypto.createVerify('SHA256');
        verify.update(JSON.stringify(payloadData));
        
        let derSignature = signature.length === 128 ? rawToDer(signature) : signature;
        if (!verify.verify(publicKey, derSignature, 'hex')) {
            console.log(chalk.yellow(`[AUTH] Cryptographic signature validation failed for address: ${uid.substring(0,8)}...`));
            return res.status(401).json({ error: "Unauthorized: Invalid Cryptographic Signature" });
        }
        
        req.user = { uid: uid }; 
        next();
    } catch (error) {
        return res.status(401).json({ error: "Unauthorized: Malformed Key or Signature Structure" });
    }
};

async function getPayPalAccessToken() {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error("PayPal credentials not configured on server.");
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
    const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
        method: "POST",
        body: "grant_type=client_credentials",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const data = await response.json();
    if (!response.ok) throw new Error("Failed to get PayPal Access Token");
    return data.access_token;
}

const fixDust = (num) => Number(Number(num).toFixed(8));

const MAX_SUPPLY = 12000000000;
let currentPrice = config.blockchain.starting_price; 

const apiCache = {
    stats: { data: null, time: 0 },
    network: { data: null, time: 0 },
    menubook: { data: null, time: 0 }
};
const CACHE_TTL = 2000;

let pendingPayPalOrders = new Map();
let pendingVerifications = new Map();

async function loadApiState() {
    try {
        const pRes = await pool.query("SELECT data FROM api_state WHERE id = 'paypal_orders'");
        if (pRes.rows.length > 0) pendingPayPalOrders = new Map(pRes.rows[0].data);
        
        const vRes = await pool.query("SELECT data FROM api_state WHERE id = 'verifications'");
        if (vRes.rows.length > 0) pendingVerifications = new Map(vRes.rows[0].data);
        console.log(chalk.green("[API] Restored API state from PostgreSQL."));
    } catch(e) {
        console.warn("[API] DB state load failed. New state initialization.");
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
    } catch(e) { console.error("[API] DB state save failed.", e); }
}

async function updateMarketEconomics() {
    try {
        await menuBook.ensureLoaded();
        menuBook._initTokenBook("SYR"); 
        const chainPrice = await nexusChain.getLastMarketPrice(config.blockchain.starting_price);
        currentPrice = menuBook.books["SYR"].lastTradePrice > 0 ? menuBook.books["SYR"].lastTradePrice : chainPrice;
        await menuBook.setInitialPrice(currentPrice, "SYR");

        menuBook.books["SYR"].asks = menuBook.books["SYR"].asks.filter(a => a.uid !== "system");
        menuBook.books["SYR"].bids = menuBook.books["SYR"].bids.filter(a => a.uid !== "system");

        await menuBook.saveOrders();

        apiCache.stats.time = 0;
        apiCache.network.time = 0;
        apiCache.menubook.time = 0;
    } catch (e) {
        console.error(chalk.red("[ECONOMICS ERROR]"), e);
    }
}

let isMining = false;
setInterval(async () => {
    if (isMining) return;
    const pendingCount = mempool.getPendingCount();
    if (pendingCount > 0) {
        isMining = true;
        const pendingTxs = mempool.getAndClear();
        const success = await nexusChain.addBlock(pendingTxs, currentPrice);
        
        if (success) {
            positionsCache.clear();
            await updateMarketEconomics();
            pendingTxs.forEach(tx => {
                if (tx.type === 'USD_WITHDRAWAL' && tx.to === 'system' && tx.isSystemGenerated) {
                    menuBook.removeMintLock(tx.from); 
                }
            });
        } else {
            console.log(chalk.red(`[AUTO-MINER] Block validation failed.`));
        }
        
        isMining = false;
    }
}, 5000); 

app.get('/health', (req, res) => { res.json({ status: 'alive', chainLength: nexusChain.blockCount, timestamp: Date.now() }); });
app.get('/config', (req, res) => { res.json({ paypalClientId: PAYPAL_CLIENT_ID }); });

app.get('/menubook', async (req, res) => { 
    await menuBook.ensureLoaded();
    if (Date.now() - apiCache.menubook.time < CACHE_TTL && apiCache.menubook.data) return res.json(apiCache.menubook.data);
    apiCache.menubook.data = { bids: menuBook.books["SYR"]?.bids || [], asks: menuBook.books["SYR"]?.asks || [], marketData: menuBook.getSpread("SYR") };
    apiCache.menubook.time = Date.now();
    res.json(apiCache.menubook.data); 
});

app.get('/network', (req, res) => { 
    if (Date.now() - apiCache.network.time < CACHE_TTL && apiCache.network.data) return res.json(apiCache.network.data);
    apiCache.network.data = { chainLength: nexusChain.blockCount, difficulty: nexusChain.difficulty, mempoolCount: mempool.getPendingCount() };
    apiCache.network.time = Date.now();
    res.json(apiCache.network.data); 
});

// Issue #5 Fixed: Pagination for price history
app.get('/pricehistory', (req, res) => {
    const limit = parseInt(req.query.limit) || 500;
    const offset = parseInt(req.query.offset) || 0;
    const paginated = nexusChain.priceHistoryCache.slice(offset, offset + limit);
    res.json(paginated);
});

app.get('/api/chart/kline', async (req, res) => {
    try {
        const { symbol = 'SYR' } = req.query;
        const query = `
            SELECT 
                date_trunc('hour', to_timestamp(timestamp_ms / 1000)) as time,
                (array_agg(amount_usd / amount ORDER BY timestamp_ms ASC))[1] as open,
                MAX(amount_usd / amount) as high,
                MIN(amount_usd / amount) as low,
                (array_agg(amount_usd / amount ORDER BY timestamp_ms DESC))[1] as close,
                SUM(amount) as volume
            FROM transactions
            WHERE token_symbol = $1 AND type = 'MARKET_TRADE' AND amount > 0 AND amount_usd > 0
            GROUP BY time
            ORDER BY time ASC
            LIMIT 500;
        `;
        const dbRes = await pool.query(query, [symbol]);
        const formatted = dbRes.rows.map(r => ({
            time: new Date(r.time).getTime(),
            open: parseFloat(r.open),
            high: parseFloat(r.high),
            low: parseFloat(r.low),
            close: parseFloat(r.close),
            volume: parseFloat(r.volume)
        }));
        res.json(formatted);
    } catch(e) {
        res.status(500).json({error: "Chart data unavailable"});
    }
});

app.get('/tokens', (req, res) => {
    const tokens = Object.keys(nexusChain.state.balances).map(ticker => {
        let totalCirculating = 0;
        for (const address in nexusChain.state.balances[ticker]) {
            if (address !== 'system') {
                totalCirculating += nexusChain.state.balances[ticker][address];
            }
        }
        const supply = ticker === 'SYR' ? (MAX_SUPPLY - nexusChain.getRemainingSupply('SYR')) : totalCirculating;
        return { ticker, supply };
    });
    res.json(tokens);
});

app.post('/positions/:uid', requireWeb3Auth, async (req, res) => {
    const uid = req.params.uid;
    if (req.user.uid !== uid) return res.status(403).json({ error: "Forbidden" });

    if (positionsCache.has(uid)) return res.json({ positions: positionsCache.get(uid) });

    let positionsArr = [];
    for (const token in nexusChain.state.balances) {
        const currentBal = nexusChain.state.getBalance(uid, token);
        if (currentBal > 0) {
            let totalSpent = 0;
            let totalAcquired = 0;
            
            try {
                const txRes = await pool.query(
                    "SELECT amount, amount_usd FROM transactions WHERE to_address = $1 AND token_symbol = $2 AND (type = 'MARKET_TRADE' OR type = 'BUY')", 
                    [uid, token]
                );
                for (const row of txRes.rows) {
                    totalSpent += (parseFloat(row.amount_usd) || 0);
                    totalAcquired += parseFloat(row.amount);
                }
            } catch(e) {
                console.error(chalk.red("[API] Positions DB query failed"), e);
            }
            
            const avgPrice = totalAcquired > 0 ? (totalSpent / totalAcquired) : (token === "SYR" ? currentPrice : 0);
            positionsArr.push({ asset: token, qty: currentBal, avgPrice: avgPrice });
        }
    }
    
    positionsCache.set(uid, positionsArr);
    res.json({ positions: positionsArr });
});

app.post('/api/orders/cancel', requireWeb3Auth, async (req, res) => {
    try {
        const { orderId, tokenSymbol = "SYR" } = req.body;
        const uid = req.user.uid;
        
        const parsedOrderId = parseInt(orderId);
        
        const success = await menuBook.cancelOrder(uid, parsedOrderId, tokenSymbol);
        if (success) {
            await updateMarketEconomics();
            res.json({ success: true, message: "Order cancelled successfully." });
        } else {
            res.status(404).json({ error: "Order not found or already executed." });
        }
    } catch (err) { res.status(500).json({ error: "Failed to cancel order." }); }
});

app.post('/api/orders/:uid', requireWeb3Auth, (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    res.json(menuBook.getUserOrders(req.params.uid, "SYR"));
});

app.post('/menubook/limit', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { side, amountSyr, priceUsd, tokenSymbol = "SYR" } = req.body;
        const uid = req.user.uid;
        
        if (!['BUY', 'SELL'].includes(side) || amountSyr <= 0 || priceUsd <= 0) return res.status(400).json({ error: "Invalid limit order parameters." });

        const parsedAmount = parseFloat(amountSyr);
        const parsedPrice = parseFloat(priceUsd);

        if (side === 'BUY') {
            const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol) - mempool.getPendingUsdSpend(uid);
            if (availableUsd < parsedAmount * parsedPrice) return res.status(400).json({ error: "Insufficient available USD." });
        } else {
            const availableToken = nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol) - mempool.getPendingTokenSpend(uid, tokenSymbol);
            if (availableToken < parsedAmount) return res.status(400).json({ error: `Insufficient available ${tokenSymbol}.` });
        }

        let remainingAmount = parsedAmount;
        let executedTrades = [];
        const fundsToCheck = side === 'BUY' 
            ? (nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol) - mempool.getPendingUsdSpend(uid)) 
            : (nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol) - mempool.getPendingTokenSpend(uid, tokenSymbol));
        
        const matchResult = await menuBook.matchMarketOrder(uid, side, remainingAmount, fundsToCheck, parsedPrice, tokenSymbol);
        executedTrades = matchResult.trades;
        remainingAmount = matchResult.remaining;

        for (const trade of executedTrades) {
            await mempool.addTransaction({ from: trade.seller, to: trade.buyer, amount: trade.amountSyr, amountUsd: trade.amountUsd, type: 'MARKET_TRADE', tokenSymbol: tokenSymbol, timestamp: Date.now() });
        }

        let order = null;
        if (remainingAmount > 0) order = await menuBook.addLimitOrder(uid, side, remainingAmount, parsedPrice, tokenSymbol);

        await updateMarketEconomics();
        res.status(201).json({ message: "Limit order processed.", order, executedTrades });
    } catch (error) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.post('/menubook/market', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { side, amountSyr, tokenSymbol = "SYR" } = req.body;
        const uid = req.user.uid;
        const parsedAmount = parseFloat(amountSyr);

        if (!['BUY', 'SELL'].includes(side) || isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ error: "Invalid market order parameters." });

        const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol) - mempool.getPendingUsdSpend(uid);
        const availableToken = nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol) - mempool.getPendingTokenSpend(uid, tokenSymbol);

        if (side === 'SELL' && parsedAmount > availableToken) {
            return res.status(400).json({ error: `Insufficient ${tokenSymbol} balance to execute trade.` });
        }
        
        if (side === 'BUY' && availableUsd <= 0) {
            return res.status(400).json({ error: `Insufficient USD balance. Deposit funds to execute trade.` });
        }

        const fundsToCheck = side === 'BUY' ? availableUsd : availableToken;
        const matchResult = await menuBook.matchMarketOrder(uid, side, parsedAmount, fundsToCheck, null, tokenSymbol);

        if (side === 'BUY' && matchResult.remaining > 1e-8 && tokenSymbol === 'SYR') {
            const systemBalance = nexusChain.getBalance('system', tokenSymbol) - mempool.getPendingTokenSpend('system', tokenSymbol);
            if (systemBalance > 0) {
                let tradeAmount = Math.min(matchResult.remaining, systemBalance);
                
                const virtualSyrReserve = 5000000; 
                const virtualUsdReserve = virtualSyrReserve * currentPrice;
                
                let stepTradeUsd = parseFloat((tradeAmount * currentPrice).toFixed(8));
                let maxAffordableTradeUsd = fundsToCheck - matchResult.totalUsdCost;

                if (maxAffordableTradeUsd < stepTradeUsd) {
                    tradeAmount = parseFloat((maxAffordableTradeUsd / currentPrice).toFixed(8));
                    stepTradeUsd = maxAffordableTradeUsd;
                }

                if (tradeAmount > 1e-8) {
                    await mempool.addTransaction({ 
                        from: 'system', 
                        to: uid, 
                        amount: tradeAmount, 
                        amountUsd: stepTradeUsd, 
                        type: 'MARKET_TRADE', 
                        tokenSymbol: tokenSymbol, 
                        timestamp: Date.now(),
                        isSystemGenerated: true
                    });

                    const newSyrReserve = virtualSyrReserve - tradeAmount;
                    const newUsdReserve = (virtualSyrReserve * virtualUsdReserve) / newSyrReserve;
                    
                    currentPrice = parseFloat((newUsdReserve / newSyrReserve).toFixed(6));
                    menuBook.books[tokenSymbol].lastTradePrice = currentPrice;
                    await menuBook.saveOrders();

                    matchResult.trades.push({ buyer: uid, seller: 'system', amountSyr: tradeAmount, amountUsd: stepTradeUsd, price: currentPrice, tokenSymbol });
                    matchResult.executedSyr = fixDust(matchResult.executedSyr + tradeAmount);
                    matchResult.remaining = fixDust(matchResult.remaining - tradeAmount);
                    matchResult.totalUsdCost = fixDust(matchResult.totalUsdCost + stepTradeUsd);
                }
            }
        }

        if (matchResult.trades.length === 0) {
            return res.status(400).json({ error: "No liquidity available in Menu Book to match order." });
        }

        for (const trade of matchResult.trades) {
            if (trade.seller !== 'system') {
                await mempool.addTransaction({ from: trade.seller, to: trade.buyer, amount: trade.amountSyr, amountUsd: trade.amountUsd, type: 'MARKET_TRADE', tokenSymbol: tokenSymbol, timestamp: Date.now() });
            }
        }

        await updateMarketEconomics();
        res.status(201).json({
            message: "Market order executed", executedSyr: matchResult.executedSyr,
            remainingUnfilled: matchResult.remaining, totalUsdCost: matchResult.totalUsdCost,
            slippagePercentage: (matchResult.slippage * 100).toFixed(2) + "%", trades: matchResult.trades
        });
    } catch (error) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.get('/blocks', async (req, res) => {
    try {
        const totalRes = await pool.query('SELECT COUNT(*) FROM blocks');
        const total = parseInt(totalRes.rows[0].count);
        
        let limit = Math.min(parseInt(req.query.limit) || 50, 200); 
        let offset = parseInt(req.query.offset) || 0;
        
        const blockRes = await pool.query('SELECT * FROM blocks ORDER BY index DESC LIMIT $1 OFFSET $2', [limit, offset]);
        if (blockRes.rows.length === 0) return res.json({ blocks: [], total, offset, limit });
        
        const indices = blockRes.rows.map(b => b.index);
        const txRes = await pool.query('SELECT * FROM transactions WHERE block_index = ANY($1::int[]) ORDER BY id ASC', [indices]);
        
        const txsByBlock = {};
        txRes.rows.forEach(tx => {
            if (!txsByBlock[tx.block_index]) txsByBlock[tx.block_index] = [];
            txsByBlock[tx.block_index].push({
                from: tx.from_address, to: tx.to_address, amount: parseFloat(tx.amount),
                amountUsd: parseFloat(tx.amount_usd), type: tx.type, tokenSymbol: tx.token_symbol, 
                timestamp: parseInt(tx.timestamp_ms), isSystemGenerated: tx.is_system_generated,
                signature: tx.signature, publicKey: tx.public_key, platformType: tx.platform_type, description: tx.description
            });
        });
        
        const page = blockRes.rows.map(b => ({
            index: b.index, timestamp: parseInt(b.timestamp_ms), 
            data: txsByBlock[b.index] || [], previousHash: b.previous_hash, 
            hash: b.hash, nonce: b.nonce
        }));
        
        res.json({ blocks: page, total, offset, limit });
    } catch(e) {
        res.status(500).json({error: "Failed to fetch blocks dynamically from database."});
    }
});

app.get('/balance/:address', (req, res) => { 
    const token = req.query.token || "SYR";
    const totalSyr = nexusChain.getBalance(req.params.address, token);
    const lockedSyr = menuBook.getLockedToken(req.params.address, token);
    res.json({ address: req.params.address, token: token, balance: totalSyr - lockedSyr, total: totalSyr, locked: lockedSyr }); 
});

app.get('/stats', (req, res) => {
  if (Date.now() - apiCache.stats.time < CACHE_TTL && apiCache.stats.data) return res.json(apiCache.stats.data);
  const remaining = nexusChain.getRemainingSupply("SYR");
  apiCache.stats.data = { maxSupply: MAX_SUPPLY, remainingSupply: remaining, circulatingSupply: MAX_SUPPLY - remaining, currentPrice, marketCap: (MAX_SUPPLY - remaining) * currentPrice };
  apiCache.stats.time = Date.now();
  res.json(apiCache.stats.data);
});

app.get('/supply', (req, res) => { res.json({ remainingSupply: nexusChain.getRemainingSupply("SYR") }); });

app.get('/miner-balance', (req, res) => {
    res.json({ address: config.blockchain.miner_address, balance: nexusChain.getBalance(config.blockchain.miner_address, "SYR") });
});

app.post('/tx/new', txLimiter, requireWeb3Auth, async (req, res) => {
  try {
      const { signature, publicKey, uid, ...payloadData } = req.body;
      const tx = { ...payloadData, amount: parseFloat(payloadData.amount) };
      
      if (signature && publicKey) {
          tx.signature = signature; tx.publicKey = publicKey; tx.uid = uid;
      }

      const { from, type, tokenSymbol = "SYR" } = tx;

      if (['BUY', 'SELL', 'MARKET_TRADE'].includes(type)) return res.status(400).json({ error: "Trades must be routed through /menubook endpoints." });
      
      if (type === 'TRANSFER') {
          if (from !== req.user.uid) return res.status(403).json({ error: "Forbidden: Originating address mismatch." });
          if ((nexusChain.getBalance(from, tokenSymbol) - menuBook.getLockedToken(from, tokenSymbol) - mempool.getPendingTokenSpend(from, tokenSymbol)) < tx.amount) return res.status(400).json({ error: `Insufficient ${tokenSymbol} balance.` });
      } else if (type === 'USD_WITHDRAWAL') {
          if (from !== req.user.uid) return res.status(403).json({ error: "Forbidden: Originating address mismatch." });
          if ((nexusChain.state.getUsd(from) - menuBook.getLockedUsd(from, tokenSymbol) - mempool.getPendingUsdSpend(from)) < tx.amount) return res.status(400).json({ error: `Insufficient USD balance.` });
      } else if (type === 'MINT' && from !== 'system') {
          return res.status(403).json({ error: "Forbidden: Only system can mint assets." });
      } else if (type === 'USD_DEPOSIT' && from !== 'paypal-gateway') {
          return res.status(403).json({ error: "Forbidden: Only gateway can authorize deposits." });
      } else if (!['USD_DEPOSIT', 'MINT'].includes(type)) {
          return res.status(400).json({ error: "Invalid transaction type." });
      }

      if (!validator.validateTransactionPayload(tx)) return res.status(400).json({ error: "Malformed payload or invalid cryptography." });

      if (await mempool.addTransaction(tx)) res.status(201).json({ message: "Transaction added to mempool.", tx });
      else res.status(400).json({ error: "MEMPOOL_FULL_OR_REPLAY" });
  } catch (error) { res.status(500).json({ error: "Internal Server Error." }); }
});

setInterval(() => {
    const now = Date.now();
    let updated = false;
    
    for (const [key, record] of pendingVerifications.entries()) {
        if (now - record.timestamp > 30 * 60 * 1000) {
            pendingVerifications.delete(key);
            updated = true;
        }
    }
    
    for (const [orderId, orderData] of pendingPayPalOrders.entries()) {
        if (now - orderData.timestamp > 24 * 60 * 60 * 1000) {
            pendingPayPalOrders.delete(orderId);
            updated = true;
        }
    }
    
    if (updated) saveApiState();
}, 15 * 60 * 1000);

app.post('/register-website', txLimiter, requireWeb3Auth, (req, res) => {
    try {
        const { websiteUrl } = req.body;
        const uid = req.user.uid;
        if (!websiteUrl || !websiteUrl.startsWith('http')) return res.status(400).json({ error: "Invalid platform URL format." });
        
        const key = 'nx_' + crypto.randomBytes(16).toString('hex');
        pendingVerifications.set(uid + websiteUrl, { key, timestamp: Date.now() });
        saveApiState();
        res.json({ key });
    } catch (err) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.post('/verify-website', txLimiter, requireWeb3Auth, async (req, res) => {
    const { websiteUrl } = req.body;
    const uid = req.user.uid;
    
    try {
        const parsedUrl = new URL(websiteUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).json({ error: "Invalid protocol specified." });
        }
        
        const hostname = parsedUrl.hostname;
        const isLocal = /^(localhost|127\.0\.0\.1|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|0\.0\.0\.0|::1)/.test(hostname);
        if (isLocal || hostname.includes('railway.internal')) {
            return res.status(400).json({ error: "Internal IP addresses and local networks are strictly prohibited." });
        }
    } catch(e) {
        return res.status(400).json({ error: "Malformed URL provided." });
    }

    const record = pendingVerifications.get(uid + websiteUrl);

    try {
        const htmlRes = await fetch(websiteUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' } 
        }).catch(() => null);
        
        if (htmlRes && htmlRes.ok) {
            const html = await htmlRes.text();
            if (record && html.includes(record.key)) {
                pendingVerifications.delete(uid + websiteUrl);
                saveApiState();
                return res.json({ verified: true });
            }
        }

        if (record) {
            try {
                const parsedUrl = new URL(websiteUrl);
                const txtUrl = `${parsedUrl.protocol}//${parsedUrl.host}/syrpts-verify.txt`;
                const txtRes = await fetch(txtUrl).catch(() => null);
                if (txtRes && txtRes.ok) {
                    const text = await txtRes.text();
                    if (text.includes(record.key)) {
                        pendingVerifications.delete(uid + websiteUrl);
                        saveApiState();
                        return res.json({ verified: true });
                    }
                }
            } catch (e) {}
        }

        res.json({ verified: false, error: "Token missing. Please ensure your key is embedded directly or utilize the fallback syrpts-verify.txt protocol for Android/Steam non-web platforms." });
    } catch (error) {
        res.status(500).json({ error: "Server node encountered an error scanning the specified platform." });
    }
});

app.post('/mint-new-cash', txLimiter, requireWeb3Auth, async (req, res) => {
    try {
        const { ticker, supply, platformType, description } = req.body;
        const uid = req.user.uid;

        const parsedSupply = parseFloat(supply);
        if (isNaN(parsedSupply) || parsedSupply <= 0 || parsedSupply > 100000000000) return res.status(400).json({ error: "Invalid supply parameter." });

        if (!ticker || typeof ticker !== 'string' || ticker.length > 10) return res.status(400).json({ error: "Invalid ticker string parameters." });
        const customTicker = ticker.toUpperCase();

        const RESERVED = [
            'SYR', 'SYSTEM', 'USD', 'PAYPAL', 'GATEWAY', 'NEXUS'
        ];
        if (RESERVED.includes(customTicker)) return res.status(400).json({ error: "Ticker utilizes a reserved network identifier." });

        if (nexusChain.state.balances[customTicker] && Object.keys(nexusChain.state.balances[customTicker]).length > 0) return res.status(400).json({ error: "This ticker already exists." });
        if (menuBook.hasMintLock(uid)) return res.status(400).json({ error: "You already have a minting transaction pending." });

        const deployFeeUsd = 1.00;
        const deployFeeSyr = parseFloat((deployFeeUsd / currentPrice).toFixed(8));

        const availableSyr = nexusChain.getBalance(uid, "SYR") - menuBook.getLockedToken(uid, "SYR") - mempool.getPendingTokenSpend(uid, "SYR");
        if (availableSyr < deployFeeSyr) return res.status(400).json({ error: `Deploying custom assets natively costs $1.00 USD worth of SYR. Insufficient balance (${deployFeeSyr} SYR required).` });

        await mempool.addTransaction({ from: uid, to: "system", amount: deployFeeSyr, type: 'TRANSFER', tokenSymbol: "SYR", timestamp: Date.now(), isSystemGenerated: true });
        
        await mempool.addTransaction({ 
            from: "system", 
            to: uid, 
            amount: parsedSupply, 
            type: 'MINT', 
            tokenSymbol: customTicker, 
            platformType: platformType || 'website',
            description: description || '',
            timestamp: Date.now() + 10, 
            isSystemGenerated: true 
        });
        
        menuBook.addMintLock(uid);
        res.status(201).json({ message: `Successfully minted ${parsedSupply} ${customTicker} on the Syrpts Network! Gas fee paid: ${deployFeeSyr} SYR`, ticker: customTicker });
    } catch (err) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.post('/usd/balance/:uid', requireWeb3Auth, (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    const totalUsd = nexusChain.state.getUsd(req.params.uid);
    const lockedUsd = menuBook.getLockedUsd(req.params.uid, "SYR"); 
    res.json({ address: req.params.uid, balance: totalUsd - lockedUsd, total: totalUsd, locked: lockedUsd });
});

// Issue #13 Fixed: Minimum deposit reduced from 10 to 1
app.post('/create-paypal-order', requireWeb3Auth, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        if (isNaN(amount) || amount < 1 || amount > 10000) return res.status(400).json({ error: "Invalid amount" }); 
        const accessToken = await getPayPalAccessToken();
        const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: amount.toFixed(2) } }] })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        
        pendingPayPalOrders.set(data.id, { uid: req.user.uid, timestamp: Date.now() });
        saveApiState();
        
        res.json({ id: data.id });
    } catch (error) { res.status(500).json({ error: "[Sys-err] Payment system offline. Check configuration." }); }
});

app.post('/capture-paypal-order', requireWeb3Auth, async (req, res) => {
    try {
        if (req.body.uid !== req.user.uid) return res.status(403).json({ error: "Forbidden" });
        const orderRecord = pendingPayPalOrders.get(req.body.orderID);
        if (!orderRecord || orderRecord.uid !== req.user.uid) return res.status(403).json({ error: "Order ownership validation mismatch." });
        
        const accessToken = await getPayPalAccessToken();
        const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${req.body.orderID}/capture`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        
        pendingPayPalOrders.delete(req.body.orderID);
        saveApiState();
        
        const capturedAmount = parseFloat(data.purchase_units[0].payments.captures[0].amount.value);
        await mempool.addTransaction({ from: "paypal-gateway", to: req.user.uid, amount: capturedAmount, type: 'USD_DEPOSIT', timestamp: Date.now(), isSystemGenerated: true });
        res.json({ status: 'COMPLETED', amount: capturedAmount });
    } catch (error) { res.status(500).json({ error: "[Sys-err] Payment system offline. Capture failed." }); }
});

// Issue #2 Fixed: Withdraw silent failure fixed to return 503 and prevent mempool burn
app.post('/usd/withdraw', requireWeb3Auth, async (req, res) => {
    try {
        const { uid, amount, paypalEmail } = req.body;
        if (uid !== req.user.uid) return res.status(403).json({ error: "Forbidden" });
        if (typeof amount !== 'number' || amount < 10) return res.status(400).json({ error: "Invalid withdrawal amount." });
        
        if (!paypalEmail || !paypalEmail.includes('@')) return res.status(400).json({ error: "Valid PayPal email is required to process withdrawals." });
        
        if ((nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, "SYR") - mempool.getPendingUsdSpend(uid)) < amount) return res.status(400).json({ error: "Insufficient available USD." });

        try {
            const accessToken = await getPayPalAccessToken();
            const payoutRes = await fetch(`${PAYPAL_API_BASE}/v1/payments/payouts`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
                body: JSON.stringify({
                    sender_batch_header: { sender_batch_id: `wdr_${Date.now()}_${uid.substring(0,6)}`, email_subject: "Syrpts Node Withdrawal" },
                    items: [{ recipient_type: "EMAIL", amount: { value: amount.toFixed(2), currency: "USD" }, receiver: paypalEmail }]
                })
            });
            const payoutData = await payoutRes.json();
            
            if (!payoutRes.ok) throw new Error(payoutData.message || "Payout rejected by PayPal");

            await mempool.addTransaction({ from: uid, to: "paypal-gateway", amount: amount, type: 'USD_WITHDRAWAL', timestamp: Date.now() });
            res.json({ success: true, message: "Withdrawal processed and dispatched." });
            
        } catch (paypalErr) {
            console.log(chalk.red("[PAYPAL PAYOUT FAILED] " + paypalErr.message));
            return res.status(503).json({ error: "Payout service unavailable. Funds not deducted." });
        }
    } catch (err) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.use((req, res) => { res.status(404).json({ error: "API Node Endpoint Not Found" }); });

(async () => {
    console.log(chalk.blue("Initializing PostgreSQL API States..."));
    await loadApiState();
    
    console.log(chalk.blue("Initializing Market Economics..."));
    
    if (nexusChain.isInitializing) { await nexusChain.isInitializing; }
    
    currentPrice = await nexusChain.getLastMarketPrice(config.blockchain.starting_price);
    await menuBook.setInitialPrice(currentPrice, "SYR");
    
    if (nexusChain.getBalance("system", "SYR") === 0 && nexusChain.blockCount <= 1) {
        const initTx = { from: "system", to: "system", amount: MAX_SUPPLY, type: "MINT", tokenSymbol: "SYR", timestamp: Date.now(), isSystemGenerated: true };
        await nexusChain.addBlock([initTx]);
    }
    
    await updateMarketEconomics();
    
    app.listen(port, "0.0.0.0", () => { 
        console.log(chalk.blue.bold(`--- SCIENTIFIC NEXUS API RUNNING ON PORT ${port} ---`)); 
    });
})();