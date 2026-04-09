import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';
import mempool from './mempool.js';
import { DataChain } from './datachain.js';
import validator from './validator.js';
import menuBook from './menubook.js'; 
import './p2p.js'; [span_30](start_span)// Start P2P on launch[span_30](end_span)
import config from './config.json' assert { type: "json" };

// ======================== SECURITY & ENV VARIABLES ========================
// Removed hardcoded defaults. [span_31](start_span)[span_32](start_span)The server will now safely crash/log if you deploy without configuring these[span_31](end_span)[span_32](end_span).
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com"; // Keep sandbox until full launch

if (!INTERNAL_SECRET || INTERNAL_SECRET.length < 32) {
    console.error(chalk.red.bold("[FATAL] INTERNAL_SECRET missing or too weak. Must be at least 32 chars."));
    process.exit(1); 
}

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
        console.warn(chalk.yellow("[SECURITY] FIREBASE_SERVICE_ACCOUNT env var missing. Auth verification may fail."));
        admin.initializeApp(); 
    }
} catch (e) {
    console.error(chalk.red("[SECURITY] Firebase Admin Init Error:"), e);
}

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || config.network.api_port;

const nexusChain = new DataChain();

const professionalStartingPrice = nexusChain.getLastMarketPrice(config.blockchain.starting_price);
menuBook.setInitialPrice(professionalStartingPrice);

// ======================== MIDDLEWARE ========================
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

const requireAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Unauthorized: Missing Bearer Token" });
    }
    const token = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; 
        next();
    } catch (error) {
        return res.status(401).json({ error: "Unauthorized: Invalid or Expired Token" });
    }
};

// ======================== PAYPAL AUTH ========================
async function getPayPalAccessToken() {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
        throw new Error("PayPal credentials not configured on server.");
    }
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
    const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
        method: "POST",
        body: "grant_type=client_credentials",
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded"
        },
    });
    const data = await response.json();
    if (!response.ok) throw new Error("Failed to get PayPal Access Token");
    return data.access_token;
}

// ======================== MARKET ECONOMICS ========================
const MAX_SUPPLY = 3000000000;
let currentPrice = professionalStartingPrice; 

if (nexusChain.getBalance("system") === 0 && nexusChain.chain.length <= 1) {
  const initTx = { from: "system", to: "system", amount: MAX_SUPPLY, type: "MINT", timestamp: Date.now() };
  nexusChain.addBlock([initTx]);
}

function updateMarketEconomics() {
    try {
        const chainPrice = nexusChain.getLastMarketPrice(config.blockchain.starting_price);
        currentPrice = Math.max(chainPrice, menuBook.lastTradePrice);
        menuBook.setInitialPrice(currentPrice);

        const remaining = nexusChain.getRemainingSupply();
        const circulating = MAX_SUPPLY - remaining;

        menuBook.asks = menuBook.asks.filter(a => a.uid !== "system");
        menuBook.bids = menuBook.bids.filter(a => a.uid !== "system");

        const hasUserAsks = menuBook.asks.some(a => a.uid !== "system");
        if (remaining > 0 && !hasUserAsks) {
            const premiumPrice = currentPrice > 0 ? currentPrice * 1.02 : config.blockchain.starting_price; 
            menuBook.asks.push({
                id: 'sys-liquidity-ask',
                uid: 'system',
                amountSyr: Math.min(remaining, 5000), 
                priceUsd: premiumPrice,
                timestamp: Date.now()
            });
            menuBook.asks.sort((a, b) => a.priceUsd - b.priceUsd || a.timestamp - b.timestamp);
        }

        const hasUserBids = menuBook.bids.some(b => b.uid !== "system");
        if (circulating > 0 && !hasUserBids) {
            [span_33](start_span)// Tightened spread floor to 90%[span_33](end_span)
            const floorPrice = currentPrice > 0 ? currentPrice * 0.90 : config.blockchain.starting_price * 0.9;
            menuBook.bids.push({
                id: 'sys-liquidity-bid',
                uid: 'system',
                amountSyr: Math.min(circulating, 1000), 
                priceUsd: floorPrice,
                timestamp: Date.now()
            });
            menuBook.bids.sort((a, b) => b.priceUsd - a.priceUsd || a.timestamp - b.timestamp);
        }
        menuBook.saveOrders();
    } catch (e) {
        console.error(chalk.red("[ECONOMICS ERROR]"), e);
    }
}
updateMarketEconomics();

// ======================== ISOLATED AUTO-MINER ========================
[span_34](start_span)[span_35](start_span)// Prevents race conditions by making the auto-miner the ONLY component that calls addBlock[span_34](end_span)[span_35](end_span).
let isMining = false;
setInterval(() => {
    if (isMining) return;
    const pendingCount = mempool.getPendingCount();
    if (pendingCount > 0) {
        isMining = true;
        const pendingTxs = mempool.getAndClear();
        const success = nexusChain.addBlock(pendingTxs, currentPrice);
        
        if (success) {
            updateMarketEconomics();
        } else {
            console.log(chalk.red(`[AUTO-MINER] Block validation failed.`));
            pendingTxs.forEach(tx => mempool.addTransaction(tx));
        }
        isMining = false;
    }
}, 5000); 

// ======================== FRONTEND ENDPOINTS ========================
app.get('/config', (req, res) => {
    res.json({ paypalClientId: PAYPAL_CLIENT_ID });
});

app.get('/menubook', (req, res) => {
    res.json({ bids: menuBook.bids, asks: menuBook.asks, marketData: menuBook.getSpread() });
});

[span_36](start_span)// Network Stats Endpoint[span_36](end_span)
app.get('/network', (req, res) => {
    res.json({
        chainLength: nexusChain.chain.length,
        difficulty: nexusChain.difficulty,
        mempoolCount: mempool.getPendingCount()
    });
});

[span_37](start_span)// Price History Chart Endpoint[span_37](end_span)
app.get('/pricehistory', (req, res) => {
    const history = [];
    for (const block of nexusChain.chain) {
        if (typeof block.data === 'string') continue;
        for (const tx of block.data) {
            if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) {
                history.push({ timestamp: tx.timestamp, price: tx.amountUsd / tx.amount });
            }
        }
    }
    res.json(history);
});

[span_38](start_span)// Positions Extraction Endpoint[span_38](end_span)
app.get('/positions/:uid', requireAuth, (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    const uid = req.params.uid;
    let totalSpent = 0;
    let totalBought = 0;

    for (const block of nexusChain.chain) {
        if (typeof block.data === 'string') continue;
        for (const tx of block.data) {
            if (tx.to === uid && (tx.type === 'MARKET_TRADE' || tx.type === 'BUY')) {
                totalSpent += tx.amountUsd || (tx.amount * currentPrice);
                totalBought += tx.amount;
            }
        }
    }
    
    const avgPrice = totalBought > 0 ? (totalSpent / totalBought) : 0;
    const currentBal = nexusChain.getBalance(uid);
    
    res.json({
        positions: currentBal > 0 ? [{ asset: "SYR", qty: currentBal, avgPrice: avgPrice }] : []
    });
});

app.post('/menubook/limit', txLimiter, requireAuth, (req, res) => {
    try {
        const { side, amountSyr, priceUsd } = req.body;
        const uid = req.user.uid;
        
        if (!['BUY', 'SELL'].includes(side) || amountSyr <= 0 || priceUsd <= 0) {
            return res.status(400).json({ error: "Invalid limit order parameters." });
        }

        const parsedAmount = parseFloat(amountSyr);
        const parsedPrice = parseFloat(priceUsd);

        if (side === 'BUY') {
            const totalCost = parsedAmount * parsedPrice;
            const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid);
            if (availableUsd < totalCost) return res.status(400).json({ error: "Insufficient available USD." });
        } else {
            const availableSyr = nexusChain.getBalance(uid) - menuBook.getLockedSyr(uid);
            if (availableSyr < parsedAmount) return res.status(400).json({ error: "Insufficient available SilverCash." });
        }

        let remainingAmount = parsedAmount;
        let executedTrades = [];
        const fundsToCheck = side === 'BUY' ? (nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid)) : (nexusChain.getBalance(uid) - menuBook.getLockedSyr(uid));
        
        const matchResult = menuBook.matchMarketOrder(uid, side, remainingAmount, fundsToCheck, parsedPrice);
        
        executedTrades = matchResult.trades;
        remainingAmount = matchResult.remaining;

        for (const trade of executedTrades) {
            const tx = { from: trade.seller, to: trade.buyer, amount: trade.amountSyr, amountUsd: trade.amountUsd, type: 'MARKET_TRADE', timestamp: Date.now() };
            mempool.addTransaction(tx);
        }

        let order = null;
        if (remainingAmount > 0) {
            order = menuBook.addLimitOrder(uid, side, remainingAmount, parsedPrice);
        }

        updateMarketEconomics();
        res.status(201).json({ message: "Limit order processed.", order, executedTrades });
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/menubook/market', txLimiter, requireAuth, (req, res) => {
    try {
        const { side, amountSyr } = req.body;
        const uid = req.user.uid;

        if (!['BUY', 'SELL'].includes(side) || amountSyr <= 0) return res.status(400).json({ error: "Invalid market order parameters." });

        const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid);
        const availableSyr = nexusChain.getBalance(uid) - menuBook.getLockedSyr(uid);
        const fundsToCheck = side === 'BUY' ? availableUsd : availableSyr;

        const matchResult = menuBook.matchMarketOrder(uid, side, parseFloat(amountSyr), fundsToCheck);

        if (matchResult.trades.length === 0) {
            return res.status(400).json({ error: "No liquidity available in Menu Book to match order." });
        }

        for (const trade of matchResult.trades) {
            const tx = { from: trade.seller, to: trade.buyer, amount: trade.amountSyr, amountUsd: trade.amountUsd, type: 'MARKET_TRADE', timestamp: Date.now() };
            mempool.addTransaction(tx);
        }

        updateMarketEconomics();
        res.status(201).json({
            message: "Market order executed", executedSyr: matchResult.executedSyr,
            remainingUnfilled: matchResult.remaining, totalUsdCost: matchResult.totalUsdCost,
            slippagePercentage: (matchResult.slippage * 100).toFixed(2) + "%", trades: matchResult.trades
        });
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/api/orders/:uid', requireAuth, (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    res.json(menuBook.getUserOrders(req.params.uid));
});

app.post('/api/orders/cancel', requireAuth, (req, res) => {
    try {
        const { uid, orderId } = req.body;
        if (req.user.uid !== uid) return res.status(403).json({ error: "Forbidden" });
        
        const success = menuBook.cancelOrder(uid, orderId);
        if (success) {
            res.json({ success: true, message: "Order cancelled successfully." });
        } else {
            res.status(404).json({ error: "Order not found or already executed." });
        }
    } catch (err) {
        res.status(500).json({ error: "Failed to cancel order." });
    }
});

// ======================== CORE BLOCKCHAIN & TRANSACTIONS ========================
app.get('/', (req, res) => { res.json({ status: "Scientific Nexus DataChain API Node is ONLINE" }); });
app.get('/blocks', (req, res) => { res.json(nexusChain.chain); });

app.get('/balance/:address', (req, res) => { 
    const address = req.params.address;
    const totalSyr = nexusChain.getBalance(address);
    const lockedSyr = menuBook.getLockedSyr(address);
    res.json({ address: address, balance: totalSyr - lockedSyr, total: totalSyr, locked: lockedSyr }); 
});

app.get('/stats', (req, res) => {
  const remaining = nexusChain.getRemainingSupply();
  res.json({ 
      maxSupply: MAX_SUPPLY, remainingSupply: remaining, circulatingSupply: MAX_SUPPLY - remaining, 
      currentPrice, marketCap: (MAX_SUPPLY - remaining) * currentPrice 
  });
});

app.get('/supply', (req, res) => { res.json({ remainingSupply: nexusChain.getRemainingSupply() }); });

app.post('/tx/new', txLimiter, requireAuth, (req, res) => {
  try {
      const { from, to, amount, type } = req.body;
      const tx = { from, to, amount: parseFloat(amount), type, timestamp: Date.now() };
      const requesterUid = req.user.uid;
      
      [span_39](start_span)[span_40](start_span)// Cryptographic signature logic placeholder for when mobile client is updated[span_39](end_span)[span_40](end_span)
      // if (!verifySignature(tx, req.body.signature)) return res.status(401).json({ error: "Invalid TX Signature" });

      if (type === 'BUY' || type === 'SELL') return res.status(400).json({ error: "Trades must be routed through /menubook/limit." });
      if (type === 'TRANSFER' && from !== requesterUid) return res.status(403).json({ error: "Forbidden: You do not own the originating address." });
      if (!validator.validateTransactionPayload(tx)) return res.status(400).json({ error: "Malformed transaction payload." });

      const senderBalance = nexusChain.getBalance(from) - menuBook.getLockedSyr(from);
      if (senderBalance < tx.amount) return res.status(400).json({ error: "Insufficient available SilverCash balance." });

      const success = mempool.addTransaction(tx);
      if (success) {
        res.status(201).json({ message: "Transaction added to mempool.", tx });
      } else {
        res.status(400).json({ error: "MEMPOOL_FULL" });
      }
  } catch (error) {
      res.status(500).json({ error: "Internal Server Error." });
  }
});

// ======================== USD & PAYPAL GATEWAY ========================
app.get('/usd/balance/:uid', requireAuth, (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    const address = req.params.uid;
    const totalUsd = nexusChain.state.getUsd(address);
    const lockedUsd = menuBook.getLockedUsd(address);
    res.json({ address: address, balance: totalUsd - lockedUsd, total: totalUsd, locked: lockedUsd });
});

app.post('/create-paypal-order', requireAuth, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        [span_41](start_span)if (isNaN(amount) || amount < 10 || amount > 10000) return res.status(400).json({ error: "Invalid amount" }); //[span_41](end_span)
        
        const accessToken = await getPayPalAccessToken();
        const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: amount.toFixed(2) } }] })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        res.json({ id: data.id });
    } catch (error) {
        console.error(chalk.red("[PAYPAL CREATE ERROR]"), error);
        res.status(500).json({ error: "[Sys-err] Payment system offline. Check configuration." });
    }
});

app.post('/capture-paypal-order', requireAuth, async (req, res) => {
    try {
        const { orderID, uid } = req.body;
        if (uid !== req.user.uid) return res.status(403).json({ error: "Forbidden" });

        const accessToken = await getPayPalAccessToken();
        const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderID}/capture`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.message);

        const capturedAmount = parseFloat(data.purchase_units[0].payments.captures[0].amount.value);

        [span_42](start_span)// Immutably record the deposit on-chain[span_42](end_span)
        const depositTx = { from: "paypal-gateway", to: uid, amount: capturedAmount, type: 'USD_DEPOSIT', timestamp: Date.now() };
        mempool.addTransaction(depositTx);

        res.json({ status: 'COMPLETED', amount: capturedAmount });
    } catch (error) {
        console.error(chalk.red("[PAYPAL CAPTURE ERROR]"), error);
        res.status(500).json({ error: "[Sys-err] Payment system offline. Capture failed." });
    }
});

[span_43](start_span)// Implement USD Withdrawals[span_43](end_span)
app.post('/usd/withdraw', requireAuth, (req, res) => {
    try {
        const { uid, amount } = req.body;
        if (uid !== req.user.uid) return res.status(403).json({ error: "Forbidden" });
        if (typeof amount !== 'number' || amount < 10) return res.status(400).json({ error: "Invalid withdrawal amount." });

        const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid);
        if (availableUsd < amount) return res.status(400).json({ error: "Insufficient available USD." });

        // Immutably record withdrawal
        const withdrawTx = { from: uid, to: "paypal-gateway", amount: amount, type: 'USD_WITHDRAWAL', timestamp: Date.now() };
        mempool.addTransaction(withdrawTx);

        // Note: Real payout integration would go here. For now, it logs and deducts locally.
        console.log(chalk.green(`[PAYOUT] Processing $${amount} withdrawal for ${uid}`));

        res.json({ success: true, message: "Withdrawal processing." });
    } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.use((req, res) => { res.status(404).json({ error: "API Node Endpoint Not Found" }); });

app.listen(port, "0.0.0.0", () => {
  console.log(chalk.blue.bold(`--- SCIENTIFIC NEXUS API RUNNING ON PORT ${port} ---`));
});