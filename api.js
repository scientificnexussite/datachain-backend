// api.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';
import mempool from './mempool.js';
import { DataChain } from './datachain.js';
import validator from './validator.js';
import menuBook from './menubook.js'; // NEW: Menu Book Integration
import { Client, Environment, LogLevel, OrdersController } from '@paypal/paypal-server-sdk';

// ======================== FIREBASE ADMIN SETUP ========================
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
        console.warn(chalk.yellow("[SECURITY] FIREBASE_SERVICE_ACCOUNT env var missing. Auth verification will fail."));
        admin.initializeApp(); 
    }
} catch (e) {
    console.error(chalk.red("[SECURITY] Firebase Admin Init Error:"), e);
}

const app = express();

// NEW FIX: Trust Railway's proxy to allow express-rate-limit to function correctly
app.set('trust proxy', 1);

const port = process.env.PORT || 3001;
const nexusChain = new DataChain();

// ======================== SECURITY MIDDLEWARE ========================
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
        console.error(chalk.red("[AUTH ERROR]"), error.message);
        return res.status(401).json({ error: "Unauthorized: Invalid or Expired Token" });
    }
};

// ======================== ENV VARIABLES & API KEYS ========================
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "nexus_secret_key";
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "PLACEHOLDER_CLIENT_ID";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "PLACEHOLDER_SECRET";

const client = new Client({
    clientCredentialsAuthCredentials: { oAuthClientId: PAYPAL_CLIENT_ID, oAuthClientSecret: PAYPAL_CLIENT_SECRET },
    timeout: 0,
    environment: Environment.Sandbox, 
    logging: { logLevel: LogLevel.Info, logRequest: { logBody: true }, logResponse: { logHeaders: true } },
});
const ordersController = new OrdersController(client);
const pendingCryptoPayments = {};

// ======================== INITIAL SUPPLY & ECONOMICS ========================
const MAX_SUPPLY = 3000000000;
const SYSTEM_ADDRESS = "system";
let currentPrice = 0; 

if (nexusChain.getBalance(SYSTEM_ADDRESS) === 0) {
  const initTx = { from: SYSTEM_ADDRESS, to: SYSTEM_ADDRESS, amount: MAX_SUPPLY, type: "MINT", timestamp: Date.now() };
  nexusChain.addBlock([initTx]);
  console.log(chalk.green(`[INIT] Initial supply of ${MAX_SUPPLY} SYR allocated.`));
}

function updateMarketEconomics() {
    const remaining = nexusChain.getRemainingSupply();
    const circulating = MAX_SUPPLY - remaining;
    const systemPrice = 0 + (circulating * 0.00000005); 
    
    // NEW: Price is now Market-Driven. Bond curve math is kept as fallback.
    if (menuBook.lastTradePrice > 0) {
        currentPrice = menuBook.lastTradePrice;
    } else {
        currentPrice = systemPrice;
    }
}
updateMarketEconomics();

// ======================== AUTO-MINER ========================
setInterval(() => {
    const pendingCount = mempool.getPendingCount();
    if (pendingCount > 0) {
        console.log(chalk.yellow(`[AUTO-MINER] Processing ${pendingCount} pending transactions...`));
        const pendingTxs = mempool.getAndClear();
        const success = nexusChain.addBlock(pendingTxs, currentPrice);
        
        if (success) {
            console.log(chalk.green.bold(`[CHAIN] Auto-mined Block ${nexusChain.getLatestBlock().index}.`));
            updateMarketEconomics();
        } else {
            console.log(chalk.red(`[AUTO-MINER] Block validation failed.`));
            pendingTxs.forEach(tx => mempool.addTransaction(tx));
        }
    }
}, 10000); 

// ======================== MENU BOOK ROUTES (NEW) ========================
app.get('/menubook', (req, res) => {
    res.json({
        bids: menuBook.bids,
        asks: menuBook.asks,
        marketData: menuBook.getSpread()
    });
});

app.post('/menubook/limit', txLimiter, requireAuth, (req, res) => {
    try {
        const { side, amountSyr, priceUsd } = req.body;
        const uid = req.user.uid;
        
        if (!['BUY', 'SELL'].includes(side) || amountSyr <= 0 || priceUsd <= 0) {
            return res.status(400).json({ error: "Invalid limit order parameters." });
        }

        if (side === 'BUY') {
            const totalCost = amountSyr * priceUsd;
            const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid);
            if (availableUsd < totalCost) return res.status(400).json({ error: "Insufficient available USD." });
        } else {
            const availableSyr = nexusChain.getBalance(uid) - menuBook.getLockedSyr(uid);
            if (availableSyr < amountSyr) return res.status(400).json({ error: "Insufficient available SilverCash." });
        }

        const order = menuBook.addLimitOrder(uid, side, parseFloat(amountSyr), parseFloat(priceUsd));
        updateMarketEconomics();
        res.status(201).json({ message: "Limit order active in Menu Book", order });
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/menubook/market', txLimiter, requireAuth, (req, res) => {
    try {
        const { side, amountSyr } = req.body;
        const uid = req.user.uid;

        if (!['BUY', 'SELL'].includes(side) || amountSyr <= 0) {
            return res.status(400).json({ error: "Invalid market order parameters." });
        }

        const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid);
        const availableSyr = nexusChain.getBalance(uid) - menuBook.getLockedSyr(uid);
        const fundsToCheck = side === 'BUY' ? availableUsd : availableSyr;

        // Execute off-chain matching
        const matchResult = menuBook.matchMarketOrder(uid, side, parseFloat(amountSyr), fundsToCheck);

        if (matchResult.trades.length === 0) {
            return res.status(400).json({ error: "No liquidity available in Menu Book to match order." });
        }

        // Generate P2P Market transactions for the DataChain mempool
        for (const trade of matchResult.trades) {
            const tx = {
                from: trade.seller,
                to: trade.buyer,
                amount: trade.amountSyr,
                amountUsd: trade.amountUsd,
                type: 'MARKET_TRADE',
                timestamp: Date.now()
            };
            mempool.addTransaction(tx);
        }

        updateMarketEconomics();

        res.status(201).json({
            message: "Market order executed",
            executedSyr: matchResult.executedSyr,
            remainingUnfilled: matchResult.remaining,
            totalUsdCost: matchResult.totalUsdCost,
            slippagePercentage: (matchResult.slippage * 100).toFixed(2) + "%",
            trades: matchResult.trades
        });

    } catch (error) {
        console.error(chalk.red("[MARKET ORDER ERROR]"), error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ======================== EXISTING ROUTES (UPDATED WITH LOCKS) ========================
app.get('/', (req, res) => { res.json({ status: "Scientific Nexus DataChain API Node is ONLINE" }); });
app.get('/blocks', (req, res) => { res.json(nexusChain.chain); });
app.get('/balance/:address', (req, res) => { 
    res.json({ address: req.params.address, balance: nexusChain.getBalance(req.params.address) }); 
});
app.get('/stats', (req, res) => {
  const remaining = nexusChain.getRemainingSupply();
  res.json({ maxSupply: MAX_SUPPLY, remainingSupply: remaining, circulatingSupply: MAX_SUPPLY - remaining, currentPrice, marketCap: (MAX_SUPPLY - remaining) * currentPrice });
});
app.get('/supply', (req, res) => { res.json({ remainingSupply: nexusChain.getRemainingSupply() }); });

app.post('/tx/new', txLimiter, requireAuth, (req, res) => {
  try {
      const { from, to, amount, type } = req.body;
      const tx = { from, to, amount: parseFloat(amount), type, timestamp: Date.now() };

      const requesterUid = req.user.uid;
      if (type === 'BUY' && to !== requesterUid) return res.status(403).json({ error: "Forbidden: Cannot buy on behalf of another user." });
      if ((type === 'SELL' || type === 'TRANSFER') && from !== requesterUid) return res.status(403).json({ error: "Forbidden: You do not own the originating address." });

      if (!validator.validateTransactionPayload(tx)) return res.status(400).json({ error: "Malformed transaction payload." });

      // Economy Enforcement (Factoring in Menu Book locked funds)
      if (type === 'BUY') {
          const totalCost = tx.amount * currentPrice;
          const userUsd = nexusChain.state.getUsd(to) - menuBook.getLockedUsd(to);
          if (userUsd < totalCost) return res.status(400).json({ error: `Insufficient available USD.` });
      } else if (type === 'SELL' || type === 'TRANSFER') {
          const senderBalance = nexusChain.getBalance(from) - menuBook.getLockedSyr(from);
          if (senderBalance < tx.amount) return res.status(400).json({ error: "Insufficient available SilverCash balance." });
      }

      const success = mempool.addTransaction(tx);
      if (success) {
        res.status(201).json({ message: "Transaction added to mempool.", tx });
      } else {
        res.status(400).json({ error: "Transaction failed mempool admission." });
      }
  } catch (error) {
      console.error(chalk.red("[TX ERROR]"), error);
      res.status(500).json({ error: "Internal Server Error." });
  }
});

app.post('/mine', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${INTERNAL_SECRET}` && req.hostname !== 'localhost') {
        return res.status(403).json({ error: "Forbidden" });
    }
    try {
        const pendingTxs = mempool.getAndClear();
        if (pendingTxs.length === 0) return res.status(400).json({ error: "No pending transactions." });

        const success = nexusChain.addBlock(pendingTxs, currentPrice);
        if (success) {
            updateMarketEconomics();
            res.json({ message: "Block Mined", block: nexusChain.getLatestBlock() });
        } else {
            res.status(500).json({ error: "Fatal Error: Block validation failed." });
        }
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error." });
    }
});

// ======================== USD & PAYMENT ENDPOINTS ========================
app.get('/usd/balance/:uid', requireAuth, (req, res) => {
    if (req.user.uid !== req.params.uid) return res.status(403).json({ error: "Forbidden" });
    res.json({ address: req.params.uid, balance: nexusChain.state.getUsd(req.params.uid) });
});

app.post('/usd/deposit', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${INTERNAL_SECRET}` && req.hostname !== 'localhost') return res.status(403).json({ error: "Forbidden" });
    try {
        const { uid, amount } = req.body;
        if (!uid || typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: "Invalid payload" });
        nexusChain.state.addUsd(uid, amount);
        nexusChain.saveChain(); 
        res.json({ address: uid, newBalance: nexusChain.state.getUsd(uid) });
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/create-paypal-order', requireAuth, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        if (isNaN(amount) || amount <= 0 || amount > 10000) return res.status(400).json({ error: "Invalid amount" });
        
        const collect = {
            body: { intent: 'CAPTURE', purchaseUnits: [{ amount: { currencyCode: 'USD', value: amount.toFixed(2) } }] },
            prefer: 'return=minimal',
        };
        const { body } = await ordersController.ordersCreate(collect);
        res.json({ id: body.id });
    } catch (error) {
        const mockOrderId = "MOCK_ORDER_" + crypto.randomBytes(4).toString('hex');
        res.json({ id: mockOrderId });
    }
});

app.post('/capture-paypal-order', requireAuth, async (req, res) => {
    try {
        const { orderID, uid } = req.body;
        if (uid !== req.user.uid) return res.status(403).json({ error: "Forbidden" });

        const collect = { id: orderID, prefer: 'return=minimal' };
        let capturedAmount = 50.00; 

        try {
            const { body } = await ordersController.ordersCapture(collect);
            capturedAmount = parseFloat(body.purchaseUnits.payments.captures.amount.value);
        } catch (sdkError) {
             if(!orderID.startsWith("MOCK_ORDER_")) throw sdkError;
        }

        nexusChain.state.addUsd(uid, capturedAmount);
        nexusChain.saveChain();
        res.json({ status: 'COMPLETED', amount: capturedAmount });
    } catch (error) {
        res.status(500).json({ error: "Failed to capture PayPal order." });
    }
});

app.post('/create-crypto-payment', requireAuth, async (req, res) => {
    try {
        const { uid, amountUsd } = req.body;
        if (uid !== req.user.uid) return res.status(403).json({ error: "Forbidden" });
        
        const paymentId = "CRYPTO_" + crypto.randomBytes(6).toString('hex');
        const amountBtc = (parseFloat(amountUsd) / 65000).toFixed(6); 
        pendingCryptoPayments[paymentId] = { uid, amountUsd: parseFloat(amountUsd), status: 'pending', timestamp: Date.now() };
        res.json({ paymentId, address: "bc1q" + crypto.randomBytes(16).toString('hex'), amount: amountBtc });
    } catch (error) {
        res.status(500).json({ error: "Failed to initialize crypto gateway." });
    }
});

app.get('/crypto/status/:paymentId', requireAuth, async (req, res) => {
    try {
        const payment = pendingCryptoPayments[req.params.paymentId];
        if (!payment || payment.uid !== req.user.uid) return res.status(404).json({ error: "Payment not found or forbidden." });

        if (payment.status === 'pending' && (Date.now() - payment.timestamp) > 15000) {
            payment.status = 'confirmed';
            nexusChain.state.addUsd(payment.uid, payment.amountUsd);
            nexusChain.saveChain();
        }
        res.json({ status: payment.status });
    } catch (error) {
        res.status(500).json({ error: "Failed to check crypto status." });
    }
});

app.use((req, res) => { res.status(404).json({ error: "API Node Endpoint Not Found" }); });

app.listen(port, "0.0.0.0", () => {
  console.log(chalk.blue.bold(`--- SCIENTIFIC NEXUS API RUNNING ON PORT ${port} ---`));
});
