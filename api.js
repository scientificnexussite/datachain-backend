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

let INTERNAL_SECRET = process.env.INTERNAL_SECRET;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE = "https://api-m.paypal.com";

if (!INTERNAL_SECRET || INTERNAL_SECRET.length < 32) {
    console.warn(chalk.yellow("[SECURITY] Auto-generating a secure 32-byte session secret to prevent crash."));
    INTERNAL_SECRET = crypto.randomBytes(32).toString('hex');
}

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || config.network.api_port;

const nexusChain = new DataChain();

const professionalStartingPrice = nexusChain.getLastMarketPrice(config.blockchain.starting_price);
menuBook.setInitialPrice(professionalStartingPrice, "SYR");

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
    
    if (!signature || !publicKey || !uid) {
        return res.status(401).json({ error: "Unauthorized: Missing Web3 ECDSA Signature." });
    }
    
    try {
        const verify = crypto.createVerify('SHA256');
        verify.update(JSON.stringify(payloadData));
        
        let derSignature = signature;
        if (signature.length === 128) {
            derSignature = rawToDer(signature);
        }
        
        const isValid = verify.verify(publicKey, derSignature, 'hex');
        
        if (!isValid) {
            console.log(chalk.red(`[AUTH] Cryptographic signature validation failed for address: ${uid.substring(0,8)}...`));
            return res.status(401).json({ error: "Unauthorized: Invalid Cryptographic Signature" });
        }
        
        req.user = { uid: uid }; 
        next();
    } catch (error) {
        console.error(chalk.red("[AUTH ERROR]"), error);
        return res.status(401).json({ error: "Unauthorized: Malformed Key or Signature Structure" });
    }
};

async function getPayPalAccessToken() {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
        throw new Error("PayPal credentials not configured on server.");
    }
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

// Updated to accurately track the 6 Billion True Supply
const MAX_SUPPLY = 6000000000;
let currentPrice = professionalStartingPrice; 

if (nexusChain.getBalance("system", "SYR") === 0 && nexusChain.chain.length <= 1) {
  const initTx = { from: "system", to: "system", amount: MAX_SUPPLY, type: "MINT", tokenSymbol: "SYR", timestamp: Date.now() };
  nexusChain.addBlock([initTx]);
}

async function updateMarketEconomics() {
    try {
        const chainPrice = nexusChain.getLastMarketPrice(config.blockchain.starting_price);
        currentPrice = menuBook.books["SYR"].lastTradePrice > 0 ? menuBook.books["SYR"].lastTradePrice : chainPrice;
        await menuBook.setInitialPrice(currentPrice, "SYR");

        const remaining = nexusChain.getRemainingSupply();
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
updateMarketEconomics(); 

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
            pendingTxs.forEach(tx => mempool.addTransaction(tx));
        }
        isMining = false;
    }
}, 5000); 

app.get('/health', (req, res) => { res.json({ status: 'alive', chainLength: nexusChain.chain.length, timestamp: Date.now() }); });
app.get('/config', (req, res) => { res.json({ paypalClientId: PAYPAL_CLIENT_ID }); });
app.get('/menubook', (req, res) => { res.json({ bids: menuBook.books["SYR"].bids, asks: menuBook.books["SYR"].asks, marketData: menuBook.getSpread("SYR") }); });
app.get('/network', (req, res) => { res.json({ chainLength: nexusChain.chain.length, difficulty: nexusChain.difficulty, mempoolCount: mempool.getPendingCount() }); });

app.get('/pricehistory', (req, res) => {
    const history = [];
    history.push({ timestamp: new Date(config.blockchain.genesis_date).getTime(), price: config.blockchain.starting_price });
    for (const block of nexusChain.chain) {
        if (typeof block.data === 'string') continue;
        for (const tx of block.data) {
            if ((tx.tokenSymbol === 'SYR' || !tx.tokenSymbol)) {
                if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) {
                    history.push({ timestamp: tx.timestamp, price: tx.amountUsd / tx.amount });
                } else if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.priceUsd) {
                    history.push({ timestamp: tx.timestamp, price: tx.priceUsd });
                }
            }
        }
    }
    history.push({ timestamp: Date.now(), price: currentPrice });
    res.json(history);
});

app.get('/positions/:uid', (req, res) => {
    const uid = req.params.uid;
    let positionsArr = [];
    for (const token in nexusChain.state.balances) {
        const currentBal = nexusChain.state.getBalance(uid, token);
        if (currentBal > 0) {
            positionsArr.push({ asset: token, qty: currentBal, avgPrice: token === "SYR" ? currentPrice : 0 });
        }
    }
    res.json({ positions: positionsArr });
});

app.get('/api/orders/:uid', (req, res) => {
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
            const totalCost = parsedAmount * parsedPrice;
            const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol);
            if (availableUsd < totalCost) return res.status(400).json({ error: "Insufficient available USD." });
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

        const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, tokenSymbol);
        const availableToken = nexusChain.getBalance(uid, tokenSymbol) - menuBook.getLockedToken(uid, tokenSymbol);
        const fundsToCheck = side === 'BUY' ? availableUsd : availableToken;

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
        const page = reversed.slice(offset, offset + limit);
        return res.json({ blocks: page, total, offset, limit });
    }
    res.json(chain);
});

app.get('/balance/:address', (req, res) => { 
    const address = req.params.address;
    const token = req.query.token || "SYR";
    const totalSyr = nexusChain.getBalance(address, token);
    const lockedSyr = menuBook.getLockedToken(address, token);
    res.json({ address: address, token: token, balance: totalSyr - lockedSyr, total: totalSyr, locked: lockedSyr }); 
});

app.get('/stats', (req, res) => {
  const remaining = nexusChain.getRemainingSupply();
  res.json({ maxSupply: MAX_SUPPLY, remainingSupply: remaining, circulatingSupply: MAX_SUPPLY - remaining, currentPrice, marketCap: (MAX_SUPPLY - remaining) * currentPrice });
});

app.get('/supply', (req, res) => { res.json({ remainingSupply: nexusChain.getRemainingSupply() }); });

app.post('/tx/new', txLimiter, requireWeb3Auth, (req, res) => {
  try {
      // FIX: Secure JSON ordering. Extracts the exact payload matching the frontend signature string.
      const { signature, publicKey, uid, ...payloadData } = req.body;
      
      const tx = { ...payloadData };
      tx.amount = parseFloat(tx.amount);
      
      // Re-attach security identifiers for validator.js
      if (signature && publicKey) {
          tx.signature = signature;
          tx.publicKey = publicKey;
          tx.uid = uid;
      }

      const requesterUid = req.user.uid;
      const from = tx.from;
      const type = tx.type;
      const tokenSymbol = tx.tokenSymbol || "SYR"; 

      if (type === 'BUY' || type === 'SELL') return res.status(400).json({ error: "Trades must be routed through /menubook/limit." });
      
      if (type === 'TRANSFER' && from !== requesterUid) {
          return res.status(403).json({ error: "Forbidden: You do not own the originating address or lacked cryptographic signature." });
      }
      
      if (!validator.validateTransactionPayload(tx)) return res.status(400).json({ error: "Malformed transaction payload or invalid cryptography." });

      const senderBalance = nexusChain.getBalance(from, tokenSymbol) - menuBook.getLockedToken(from, tokenSymbol);
      if (senderBalance < tx.amount) return res.status(400).json({ error: `Insufficient available ${tokenSymbol} balance.` });

      const success = mempool.addTransaction(tx);
      if (success) {
        res.status(201).json({ message: "Transaction added to mempool.", tx });
      } else { res.status(400).json({ error: "MEMPOOL_FULL" }); }
  } catch (error) { res.status(500).json({ error: "Internal Server Error." }); }
});

app.post('/mint-new-cash', txLimiter, requireWeb3Auth, (req, res) => {
    try {
        const { ticker, supply } = req.body;
        const uid = req.user.uid;

        if (!ticker || typeof ticker !== 'string' || ticker.length > 10 || ticker === 'SYR' || supply <= 0) {
            return res.status(400).json({ error: "Invalid ticker symbol or supply." });
        }

        const customTicker = ticker.toUpperCase();

        const deployFee = 100;
        const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, "SYR");
        
        if (availableUsd < deployFee) {
            return res.status(400).json({ error: `Deploying a new Cash on the network costs $${deployFee} USD. Insufficient funds.` });
        }

        const feeTx = { from: uid, to: "system", amount: deployFee, type: 'USD_WITHDRAWAL', timestamp: Date.now() };
        const mintTx = { from: "system", to: uid, amount: parseFloat(supply), type: 'MINT', tokenSymbol: customTicker, timestamp: Date.now() };

        mempool.addTransaction(feeTx);
        mempool.addTransaction(mintTx);

        res.status(201).json({ message: `Successfully minted ${supply} ${customTicker} on the Syrpts Network!`, ticker: customTicker });
    } catch (err) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.get('/usd/balance/:uid', (req, res) => {
    const address = req.params.uid;
    const totalUsd = nexusChain.state.getUsd(address);
    const lockedUsd = menuBook.getLockedUsd(address, "SYR"); 
    res.json({ address: address, balance: totalUsd - lockedUsd, total: totalUsd, locked: lockedUsd });
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
        mempool.addTransaction({ from: "paypal-gateway", to: uid, amount: capturedAmount, type: 'USD_DEPOSIT', timestamp: Date.now() });

        res.json({ status: 'COMPLETED', amount: capturedAmount });
    } catch (error) { res.status(500).json({ error: "[Sys-err] Payment system offline. Capture failed." }); }
});

app.post('/usd/withdraw', requireWeb3Auth, (req, res) => {
    try {
        const { uid, amount } = req.body;
        if (uid !== req.user.uid) return res.status(403).json({ error: "Forbidden" });
        if (typeof amount !== 'number' || amount < 10) return res.status(400).json({ error: "Invalid withdrawal amount." });

        const availableUsd = nexusChain.state.getUsd(uid) - menuBook.getLockedUsd(uid, "SYR");
        if (availableUsd < amount) return res.status(400).json({ error: "Insufficient available USD." });

        mempool.addTransaction({ from: uid, to: "paypal-gateway", amount: amount, type: 'USD_WITHDRAWAL', timestamp: Date.now() });
        res.json({ success: true, message: "Withdrawal processing." });
    } catch (err) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.use((req, res) => { res.status(404).json({ error: "API Node Endpoint Not Found" }); });
app.listen(port, "0.0.0.0", () => { console.log(chalk.blue.bold(`--- SCIENTIFIC NEXUS API RUNNING ON PORT ${port} ---`)); });