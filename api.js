import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto'; 
import mempool from './mempool.js';
import { DataChain } from './datachain.js';
import validator from './validator.js';
import menuBook from './menubook.js'; 
import './p2p.js'; 
import config from './config.json' with { type: "json" };

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE = "https://api-m.paypal.com";

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || config.network.api_port;

const nexusChain = new DataChain();

app.use(helmet()); 
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));
app.use(bodyParser.json({ limit: '100kb' })); 

const txLimiter = rateLimit({
    windowMs: 60 * 1000, 
    max: 20, 
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
        console.log(chalk.yellow("[AUTH ERROR] Malformed Key or Signature Structure"));
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

const MAX_SUPPLY = 6000000000;
let currentPrice = config.blockchain.starting_price; 
const activeMintLocks = new Set(); 

// In-Memory Cache to prevent Self-DDoS from Frontend Polling
const apiCache = {
    stats: { data: null, time: 0 },
    network: { data: null, time: 0 },
    menubook: { data: null, time: 0 }
};
const CACHE_TTL = 2000; // 2 seconds

async function updateMarketEconomics() {
    try {
        menuBook._initTokenBook("SYR"); 
        const chainPrice = nexusChain.getLastMarketPrice(config.blockchain.starting_price);
        currentPrice = menuBook.books["SYR"].lastTradePrice > 0 ? menuBook.books["SYR"].lastTradePrice : chainPrice;
        await menuBook.setInitialPrice(currentPrice, "SYR");

        const remaining = nexusChain.getRemainingSupply("SYR");
        const circulating = MAX_SUPPLY - remaining;

        menuBook.books["SYR"].asks = menuBook.books["SYR"].asks.filter(a => a.uid !== "system");
        menuBook.books["SYR"].bids = menuBook.books["SYR"].bids.filter(a => a.uid !== "system");

        const hasUserAsks = menuBook.books["SYR"].asks.some(a => a.uid !== "system");
        if (remaining > 0 && !hasUserAsks) {
            const tiers = [
                { multiplier: 1.02, amount: Math.min(remaining, 10000) },
                { multiplier: 1.05, amount: Math.min(remaining, 25000) },
                { multiplier: 1.10, amount: Math.min(remaining, 50000) },
            ];
            let tierRemaining = remaining;
            for (const tier of tiers) {
                if (tierRemaining <= 0) break;
                const tierAmount = Math.min(tier.amount, tierRemaining);
                const tierPrice = currentPrice > 0 ? currentPrice * tier.multiplier : config.blockchain.starting_price * tier.multiplier;
                menuBook.books["SYR"].asks.push({ id: `sys-liquidity-ask-${tier.multiplier}`, uid: 'system', amountSyr: tierAmount, priceUsd: tierPrice, timestamp: Date.now() });
                tierRemaining -= tierAmount;
            }
            menuBook.books["SYR"].asks.sort((a, b) => a.priceUsd - b.priceUsd || a.timestamp - b.timestamp);
        }

        const hasUserBids = menuBook.books["SYR"].bids.some(b => b.uid !== "system");
        if (circulating > 0 && !hasUserBids) {
            const floorPrice = currentPrice > 0 ? currentPrice * 0.90 : config.blockchain.starting_price * 0.9;
            menuBook.books["SYR"].bids.push({ id: 'sys-liquidity-bid', uid: 'system', amountSyr: Math.min(circulating, 5000), priceUsd: floorPrice, timestamp: Date.now() });
            menuBook.books["SYR"].bids.sort((a, b) => b.priceUsd - a.priceUsd || a.timestamp - b.timestamp);
        }
        await menuBook.saveOrders();
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
            await updateMarketEconomics();
        } else {
            console.log(chalk.red(`[AUTO-MINER] Block validation failed.`));
        }
        
        // Safely clear locks regardless of transaction success/drop
        pendingTxs.forEach(tx => {
            if (tx.type === 'USD_WITHDRAWAL' && tx.to === 'system') activeMintLocks.delete(tx.from);
        });
        isMining = false;
    }
}, 5000); 

app.get('/health', (req, res) => { res.json({ status: 'alive', chainLength: nexusChain.chain.length, timestamp: Date.now() }); });
app.get('/config', (req, res) => { res.json({ paypalClientId: PAYPAL_CLIENT_ID }); });

app.get('/menubook', (req, res) => { 
    if (Date.now() - apiCache.menubook.time < CACHE_TTL && apiCache.menubook.data) return res.json(apiCache.menubook.data);
    apiCache.menubook.data = { bids: menuBook.books["SYR"]?.bids || [], asks: menuBook.books["SYR"]?.asks || [], marketData: menuBook.getSpread("SYR") };
    apiCache.menubook.time = Date.now();
    res.json(apiCache.menubook.data); 
});

app.get('/network', (req, res) => { 
    if (Date.now() - apiCache.network.time < CACHE_TTL && apiCache.network.data) return res.json(apiCache.network.data);
    apiCache.network.data = { chainLength: nexusChain.chain.length, difficulty: nexusChain.difficulty, mempoolCount: mempool.getPendingCount() };
    apiCache.network.time = Date.now();
    res.json(apiCache.network.data); 
});

app.get('/pricehistory', (req, res) => {
    const history = [];
    history.push({ timestamp: new Date(config.blockchain.genesis_date).getTime(), price: config.blockchain.starting_price });
    for (const block of nexusChain.chain) {
        if (typeof block.data === 'string') continue;
        for (const tx of block.data) {
            if ((tx.tokenSymbol === 'SYR' || !tx.tokenSymbol)) {
                if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) history.push({ timestamp: tx.timestamp, price: tx.amountUsd / tx.amount });
                else if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.priceUsd) history.push({ timestamp: tx.timestamp, price: tx.priceUsd });
            }
        }
    }
    history.push({ timestamp: Date.now(), price: currentPrice });
    res.json(history);
});

app.post('/positions/:uid', requireWeb3Auth, (req, res) => {
    const uid = req.params.uid;
    if (req.user.uid !== uid) return res.status(403).json({ error: "Forbidden" });

    let positionsArr = [];
    for (const token in nexusChain.state.balances) {
        const currentBal = nexusChain.state.getBalance(uid, token);
        if (currentBal > 0) {
            let totalSpent = 0;
            let totalAcquired = 0;
            for (const block of nexusChain.chain) {
                if (typeof block.data === 'string') continue;
                for (const tx of block.data) {
                    if (tx.to === uid && tx.tokenSymbol === token && (tx.type === 'MARKET_TRADE' || tx.type === 'BUY')) {
                        totalSpent += (tx.amountUsd || 0);
                        totalAcquired += tx.amount;
                    }
                }
            }
            const avgPrice = totalAcquired > 0 ? (totalSpent / totalAcquired) : (token === "SYR" ? currentPrice : 0);
            positionsArr.push({ asset: token, qty: currentBal, avgPrice: avgPrice });
        }
    }
    res.json({ positions: positionsArr });
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
            const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol);
            if (availableUsd < parsedAmount * parsedPrice) return res.status(400).json({ error: "Insufficient available USD." });
        } else {
            const availableToken = nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol);
            if (availableToken < parsedAmount) return res.status(400).json({ error: `Insufficient available ${tokenSymbol}.` });
        }

        let remainingAmount = parsedAmount;
        let executedTrades = [];
        const fundsToCheck = side === 'BUY' ? (nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol)) : (nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol));
        
        const matchResult = await menuBook.matchMarketOrder(uid, side, remainingAmount, fundsToCheck, parsedPrice, tokenSymbol);
        executedTrades = matchResult.trades;
        remainingAmount = matchResult.remaining;

        for (const trade of executedTrades) {
            mempool.addTransaction({ from: trade.seller, to: trade.buyer, amount: trade.amountSyr, amountUsd: trade.amountUsd, type: 'MARKET_TRADE', tokenSymbol: tokenSymbol, timestamp: Date.now() });
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

        if (!['BUY', 'SELL'].includes(side) || amountSyr <= 0) return res.status(400).json({ error: "Invalid market order parameters." });

        const fundsToCheck = side === 'BUY' ? (nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol)) : (nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol));
        const matchResult = await menuBook.matchMarketOrder(uid, side, parseFloat(amountSyr), fundsToCheck, null, tokenSymbol);

        if (matchResult.trades.length === 0) return res.status(400).json({ error: "No liquidity available in Menu Book to match order." });

        for (const trade of matchResult.trades) {
            mempool.addTransaction({ from: trade.seller, to: trade.buyer, amount: trade.amountSyr, amountUsd: trade.amountUsd, type: 'MARKET_TRADE', tokenSymbol: tokenSymbol, timestamp: Date.now() });
        }

        await updateMarketEconomics();
        res.status(201).json({
            message: "Market order executed", executedSyr: matchResult.executedSyr,
            remainingUnfilled: matchResult.remaining, totalUsdCost: matchResult.totalUsdCost,
            slippagePercentage: (matchResult.slippage * 100).toFixed(2) + "%", trades: matchResult.trades
        });
    } catch (error) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.post('/api/orders/cancel', requireWeb3Auth, async (req, res) => {
    try {
        const { uid, orderId, tokenSymbol = "SYR" } = req.body;
        if (req.user.uid !== uid) return res.status(403).json({ error: "Forbidden" });
        
        const success = await menuBook.cancelOrder(uid, orderId, tokenSymbol);
        if (success) {
            await updateMarketEconomics();
            res.json({ success: true, message: "Order cancelled successfully." });
        } else {
            res.status(404).json({ error: "Order not found or already executed." });
        }
    } catch (err) { res.status(500).json({ error: "Failed to cancel order." }); }
});

app.get('/', (req, res) => { res.json({ status: "Scientific Nexus DataChain API Node is ONLINE" }); });

app.get('/blocks', (req, res) => {
    const chain = nexusChain.chain;
    const total = chain.length;
    if (req.query.limit !== undefined || req.query.offset !== undefined) {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200); 
        const offset = parseInt(req.query.offset) || 0;
        const reversed = [...chain].reverse();
        return res.json({ blocks: reversed.slice(offset, offset + limit), total, offset, limit });
    }
    res.json(chain);
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

app.get('/admin/miner-balance', (req, res) => {
    res.json({ address: config.blockchain.miner_address, balance: nexusChain.getBalance(config.blockchain.miner_address, "SYR") });
});

app.post('/tx/new', txLimiter, requireWeb3Auth, (req, res) => {
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
          if ((nexusChain.getBalance(from, tokenSymbol) - menuBook.getLockedToken(from, tokenSymbol)) < tx.amount) return res.status(400).json({ error: `Insufficient ${tokenSymbol} balance.` });
      } else if (type === 'USD_WITHDRAWAL') {
          if (from !== req.user.uid) return res.status(403).json({ error: "Forbidden: Originating address mismatch." });
          if ((nexusChain.state.getUsd(from) - menuBook.getLockedUsd(from, tokenSymbol)) < tx.amount) return res.status(400).json({ error: `Insufficient USD balance.` });
      } else if (!['USD_DEPOSIT', 'MINT'].includes(type)) {
          return res.status(400).json({ error: "Invalid transaction type." });
      }

      if (!validator.validateTransactionPayload(tx)) return res.status(400).json({ error: "Malformed payload or invalid cryptography." });

      if (mempool.addTransaction(tx)) res.status(201).json({ message: "Transaction added to mempool.", tx });
      else res.status(400).json({ error: "MEMPOOL_FULL" });
  } catch (error) { res.status(500).json({ error: "Internal Server Error." }); }
});

app.post('/mint-new-cash', txLimiter, requireWeb3Auth, (req, res) => {
    try {
        const { ticker, supply } = req.body;
        const uid = req.user.uid;

        if (!ticker || typeof ticker !== 'string' || ticker.length > 10 || ticker === 'SYR' || supply <= 0) return res.status(400).json({ error: "Invalid parameters." });
        const customTicker = ticker.toUpperCase();

        if (nexusChain.state.balances[customTicker] && Object.keys(nexusChain.state.balances[customTicker]).length > 0) return res.status(400).json({ error: "This ticker already exists." });
        if (activeMintLocks.has(uid)) return res.status(400).json({ error: "You already have a minting transaction pending." });

        const deployFee = 100;
        if ((nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, "SYR")) < deployFee) return res.status(400).json({ error: `Deploying costs $${deployFee} USD. Insufficient funds.` });

        mempool.addTransaction({ from: uid, to: "system", amount: deployFee, type: 'USD_WITHDRAWAL', timestamp: Date.now(), isSystemGenerated: true });
        mempool.addTransaction({ from: "system", to: uid, amount: parseFloat(supply), type: 'MINT', tokenSymbol: customTicker, timestamp: Date.now(), isSystemGenerated: true });
        
        activeMintLocks.add(uid);
        res.status(201).json({ message: `Successfully minted ${supply} ${customTicker} on the Syrpts Network!`, ticker: customTicker });
    } catch (err) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.post('/usd/balance/:uid', requireWeb3Auth, (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    const totalUsd = nexusChain.state.getUsd(req.params.uid);
    const lockedUsd = menuBook.getLockedUsd(req.params.uid, "SYR"); 
    res.json({ address: req.params.uid, balance: totalUsd - lockedUsd, total: totalUsd, locked: lockedUsd });
});

app.post('/create-paypal-order', requireWeb3Auth, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        if (isNaN(amount) || amount < 10 || amount > 10000) return res.status(400).json({ error: "Invalid amount" }); 
        const accessToken = await getPayPalAccessToken();
        const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: amount.toFixed(2) } }] })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        res.json({ id: data.id });
    } catch (error) { res.status(500).json({ error: "[Sys-err] Payment system offline. Check configuration." }); }
});

app.post('/capture-paypal-order', requireWeb3Auth, async (req, res) => {
    try {
        if (req.body.uid !== req.user.uid) return res.status(403).json({ error: "Forbidden" });
        const accessToken = await getPayPalAccessToken();
        const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${req.body.orderID}/capture`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        const capturedAmount = parseFloat(data.purchase_units[0].payments.captures[0].amount.value);
        mempool.addTransaction({ from: "paypal-gateway", to: req.user.uid, amount: capturedAmount, type: 'USD_DEPOSIT', timestamp: Date.now(), isSystemGenerated: true });
        res.json({ status: 'COMPLETED', amount: capturedAmount });
    } catch (error) { res.status(500).json({ error: "[Sys-err] Payment system offline. Capture failed." }); }
});

app.post('/usd/withdraw', requireWeb3Auth, (req, res) => {
    try {
        const { uid, amount } = req.body;
        if (uid !== req.user.uid) return res.status(403).json({ error: "Forbidden" });
        if (typeof amount !== 'number' || amount < 10) return res.status(400).json({ error: "Invalid withdrawal amount." });
        if ((nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, "SYR")) < amount) return res.status(400).json({ error: "Insufficient available USD." });

        mempool.addTransaction({ from: uid, to: "paypal-gateway", amount: amount, type: 'USD_WITHDRAWAL', timestamp: Date.now(), signature: req.body.signature, publicKey: req.body.publicKey });
        res.json({ success: true, message: "Withdrawal processing." });
    } catch (err) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.use((req, res) => { res.status(404).json({ error: "API Node Endpoint Not Found" }); });

(async () => {
    console.log(chalk.blue("Initializing Market Economics..."));
    currentPrice = nexusChain.getLastMarketPrice(config.blockchain.starting_price);
    await menuBook.setInitialPrice(currentPrice, "SYR");
    
    if (nexusChain.getBalance("system", "SYR") === 0 && nexusChain.chain.length <= 1) {
        const initTx = { from: "system", to: "system", amount: MAX_SUPPLY, type: "MINT", tokenSymbol: "SYR", timestamp: Date.now() };
        await nexusChain.addBlock([initTx]);
    }
    
    await updateMarketEconomics();
    
    app.listen(port, "0.0.0.0", () => { 
        console.log(chalk.blue.bold(`--- SCIENTIFIC NEXUS API RUNNING ON PORT ${port} ---`)); 
    });
})();