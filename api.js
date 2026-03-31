// api.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import crypto from 'crypto'; // Required for gateway generation
import mempool from './mempool.js';
import { DataChain } from './datachain.js';
import validator from './validator.js';

// NEW: PayPal Server SDK Integrations
import { Client, Environment, LogLevel, OrdersController } from '@paypal/paypal-server-sdk';

const app = express();
const port = process.env.PORT || 3001;
const nexusChain = new DataChain();

// ======================== ENV VARIABLES & API KEYS ========================
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "nexus_secret_key";
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "PLACEHOLDER_CLIENT_ID";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "PLACEHOLDER_SECRET";
const CRYPTO_API_KEY = process.env.CRYPTO_API_KEY || "PLACEHOLDER_NOWPAYMENTS_KEY";

// Setup PayPal Client
const client = new Client({
    clientCredentialsAuthCredentials: {
        oAuthClientId: PAYPAL_CLIENT_ID,
        oAuthClientSecret: PAYPAL_CLIENT_SECRET
    },
    timeout: 0,
    environment: Environment.Sandbox, // Change to Environment.Production when live
    logging: {
        logLevel: LogLevel.Info,
        logRequest: { logBody: true },
        logResponse: { logHeaders: true },
    },
});
const ordersController = new OrdersController(client);

// In-memory store for pending crypto payments (clears on restart)
const pendingCryptoPayments = {};

// ======================== INITIAL SUPPLY & ECONOMICS ========================
const MAX_SUPPLY = 3000000000;
const SYSTEM_ADDRESS = "system";

let currentPrice = 0.00000001; 

if (nexusChain.getBalance(SYSTEM_ADDRESS) === 0) {
  const initTx = {
    from: SYSTEM_ADDRESS,
    to: SYSTEM_ADDRESS,
    amount: MAX_SUPPLY,
    type: "MINT",
    timestamp: Date.now()
  };
  nexusChain.addBlock([initTx]);
  console.log(chalk.green(`[INIT] Initial supply of ${MAX_SUPPLY} SYR allocated to system address.`));
}

function updateMarketEconomics() {
    const remaining = nexusChain.getRemainingSupply();
    const circulating = MAX_SUPPLY - remaining;
    currentPrice = 0.00000001 + (circulating * 0.00000005); 
}
updateMarketEconomics();

// ======================== AUTO-MINER ========================
setInterval(() => {
    const pendingCount = mempool.getPendingCount();
    if (pendingCount > 0) {
        console.log(chalk.yellow(`[AUTO-MINER] Processing ${pendingCount} pending transactions...`));
        const pendingTxs = mempool.getAndClear();
        const success = nexusChain.addBlock(pendingTxs);
        
        if (success) {
            console.log(chalk.green.bold(`[CHAIN] Auto-mined Block ${nexusChain.getLatestBlock().index}.`));
            updateMarketEconomics();
        } else {
            console.log(chalk.red(`[AUTO-MINER] Block validation failed.`));
            pendingTxs.forEach(tx => mempool.addTransaction(tx));
        }
    }
}, 10000); 

// ======================== CORS MIDDLEWARE ========================
app.use(cors()); 
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(bodyParser.json());

// ======================== EXISTING SYR ROUTES ========================
app.get('/', (req, res) => { res.json({ status: "Scientific Nexus DataChain API Node is ONLINE", network: "SYRPTS" }); });
app.get('/blocks', (req, res) => { res.json(nexusChain.chain); });
app.get('/balance/:address', (req, res) => {
  const address = req.params.address;
  const balance = nexusChain.getBalance(address);
  res.json({ address, balance });
});
app.get('/stats', (req, res) => {
  const remaining = nexusChain.getRemainingSupply();
  const circulating = MAX_SUPPLY - remaining;
  const marketCap = circulating * currentPrice;
  res.json({ maxSupply: MAX_SUPPLY, remainingSupply: remaining, circulatingSupply: circulating, currentPrice, marketCap });
});
app.get('/supply', (req, res) => { res.json({ remainingSupply: nexusChain.getRemainingSupply() }); });

app.post('/tx/new', (req, res) => {
  try {
      const { from, to, amount, type } = req.body;
      const tx = { from, to, amount, type, timestamp: Date.now() };

      const senderBalance = nexusChain.getBalance(from);
      if (!validator.validateTransaction(tx, senderBalance)) {
        return res.status(400).json({ error: "Insufficient balance or invalid transaction." });
      }

      const success = mempool.addTransaction(tx);
      if (success) {
        res.status(201).json({ message: "Transaction added to mempool.", tx });
      } else {
        res.status(400).json({ error: "Transaction failed validation" });
      }
  } catch (error) {
      console.error(chalk.red("[TX ERROR]"), error);
      res.status(500).json({ error: "Internal Server Error." });
  }
});

app.post('/mine', (req, res) => {
  try {
      const pendingTxs = mempool.getAndClear();
      if (pendingTxs.length === 0) return res.status(400).json({ error: "No pending transactions." });

      const success = nexusChain.addBlock(pendingTxs);
      if (success) {
        updateMarketEconomics();
        console.log(chalk.green.bold(`[CHAIN] Block ${nexusChain.getLatestBlock().index} successfully added.`));
        res.json({ message: "Block Mined", block: nexusChain.getLatestBlock() });
      } else {
        res.status(500).json({ error: "Fatal Error: Block validation failed." });
      }
  } catch (error) {
      res.status(500).json({ error: "Internal Server Error." });
  }
});


// ======================== NEW USD & PAYMENT ENDPOINTS ========================

// 1. GET USD Balance
app.get('/usd/balance/:uid', (req, res) => {
    try {
        const uid = req.params.uid;
        const balance = nexusChain.state.getUsd(uid);
        res.json({ address: uid, balance: balance });
    } catch (error) {
        console.error(chalk.red("[USD BALANCE ERROR]"), error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 2. POST USD Deposit (Internal/Protected)
app.post('/usd/deposit', (req, res) => {
    try {
        const { uid, amount } = req.body;
        const authHeader = req.headers.authorization;

        // Verify request comes from localhost or has the secret
        // In full production, enforce this strictly.
        if (authHeader !== `Bearer ${INTERNAL_SECRET}` && req.hostname !== 'localhost') {
             console.log(chalk.yellow(`[SECURITY] Warning: Unverified /usd/deposit attempt. Protect this endpoint in production.`));
        }

        if (!uid || !amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid payload" });
        }

        nexusChain.state.addUsd(uid, amount);
        nexusChain.saveChain(); // Atomic save to persistent volume
        
        console.log(chalk.green(`[USD DEPOSIT] Added $${amount} to user ${uid}`));
        res.json({ address: uid, newBalance: nexusChain.state.getUsd(uid) });

    } catch (error) {
        console.error(chalk.red("[USD DEPOSIT ERROR]"), error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 3. POST Create PayPal Order
app.post('/create-paypal-order', async (req, res) => {
    try {
        const { amount } = req.body;
        
        const collect = {
            body: {
                intent: 'CAPTURE',
                purchaseUnits: [
                    { amount: { currencyCode: 'USD', value: parseFloat(amount).toFixed(2) } },
                ],
            },
            prefer: 'return=minimal',
        };

        const { body, ...httpResponse } = await ordersController.ordersCreate(collect);
        res.json({ id: body.id });
    } catch (error) {
        console.error(chalk.red("[PAYPAL CREATE ERROR]"), error);
        // Fallback for demo/testing if SDK fails due to missing credentials
        const mockOrderId = "MOCK_ORDER_" + crypto.randomBytes(4).toString('hex');
        console.log(chalk.yellow(`[PAYPAL] Fallback to mock order ID: ${mockOrderId}`));
        res.json({ id: mockOrderId });
    }
});

// 4. POST Capture PayPal Order
app.post('/capture-paypal-order', async (req, res) => {
    try {
        const { orderID, uid } = req.body;
        const collect = { id: orderID, prefer: 'return=minimal' };

        let capturedAmount = 50.00; // Default fallback

        try {
            const { body, ...httpResponse } = await ordersController.ordersCapture(collect);
            capturedAmount = parseFloat(body.purchaseUnits.payments.captures.amount.value);
        } catch (sdkError) {
             console.log(chalk.yellow(`[PAYPAL] SDK Capture failed, assuming mock capture for order: ${orderID}`));
             if(!orderID.startsWith("MOCK_ORDER_")) throw sdkError;
        }

        // Apply to ledger
        nexusChain.state.addUsd(uid, capturedAmount);
        nexusChain.saveChain();

        console.log(chalk.green(`[PAYPAL CAPTURE] Order ${orderID} completed. Added $${capturedAmount} to ${uid}`));
        res.json({ status: 'COMPLETED', amount: capturedAmount });

    } catch (error) {
        console.error(chalk.red("[PAYPAL CAPTURE ERROR]"), error);
        res.status(500).json({ error: "Failed to capture PayPal order." });
    }
});

// 5. POST Create Crypto Payment (Gateway architecture placeholder)
app.post('/create-crypto-payment', async (req, res) => {
    try {
        const { uid, amountUsd } = req.body;
        
        // This is where you call NOWPayments/Coinbase API. Mocked below:
        const paymentId = "CRYPTO_" + crypto.randomBytes(6).toString('hex');
        const depositAddress = "bc1q" + crypto.randomBytes(16).toString('hex'); 
        
        const amountBtc = (parseFloat(amountUsd) / 65000).toFixed(6); // Assumes $65k BTC

        // Store active payment state in memory
        pendingCryptoPayments[paymentId] = { 
            uid, 
            amountUsd: parseFloat(amountUsd), 
            status: 'pending',
            timestamp: Date.now()
        };

        console.log(chalk.blue(`[CRYPTO] Created payment request ${paymentId} for ${uid}`));
        res.json({ paymentId, address: depositAddress, amount: amountBtc });

    } catch (error) {
        console.error(chalk.red("[CRYPTO CREATE ERROR]"), error);
        res.status(500).json({ error: "Failed to initialize crypto gateway." });
    }
});

// 6. GET Check Crypto Status
app.get('/crypto/status/:paymentId', async (req, res) => {
    try {
        const { paymentId } = req.params;
        const payment = pendingCryptoPayments[paymentId];

        if (!payment) return res.status(404).json({ error: "Payment ID not found." });

        // Placeholder for polling the real gateway.
        // For simulation, we auto-confirm after 15 seconds.
        const timeElapsed = Date.now() - payment.timestamp;
        
        if (payment.status === 'pending' && timeElapsed > 15000) {
            payment.status = 'confirmed';
            
            nexusChain.state.addUsd(payment.uid, payment.amountUsd);
            nexusChain.saveChain();
            
            console.log(chalk.green(`[CRYPTO CAPTURE] Payment ${paymentId} confirmed. Added $${payment.amountUsd} to ${payment.uid}`));
        }

        res.json({ status: payment.status });

    } catch (error) {
        console.error(chalk.red("[CRYPTO STATUS ERROR]"), error);
        res.status(500).json({ error: "Failed to check crypto status." });
    }
});

app.use((req, res) => { res.status(404).json({ error: "API Node Endpoint Not Found" }); });

// ======================== START SERVER ========================
app.listen(port, "0.0.0.0", () => {
  console.log(chalk.blue.bold(`--- SCIENTIFIC NEXUS API RUNNING ON PORT ${port} ---`));
  console.log(chalk.white(`Railway URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || 'Active'}`));
});
