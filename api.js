import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import mempool from './mempool.js';
import { DataChain } from './datachain.js';
import validator from './validator.js';

const app = express();
const port = process.env.PORT || 3001;
const nexusChain = new DataChain();

// ======================== INITIAL SUPPLY & ECONOMICS ========================
const MAX_SUPPLY = 3000000000;
const SYSTEM_ADDRESS = "system";

// Base price variables
let currentPrice = 0.0001; 

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

// Deterministic Price Calculation based on Supply
function updateMarketEconomics() {
    const remaining = nexusChain.getRemainingSupply();
    const circulating = MAX_SUPPLY - remaining;
    // Price increases slightly for every coin sold
    currentPrice = 0.0001 + (circulating * 0.00000005); 
}

// Initial calculation on boot
updateMarketEconomics();

// ======================== AUTO-MINER (RAILWAY SAFE) ========================
// Replaces the external fetch loop which fails on Railway
setInterval(() => {
    const pendingCount = mempool.getPendingCount();
    if (pendingCount > 0) {
        console.log(chalk.yellow(`[AUTO-MINER] Processing ${pendingCount} pending transactions...`));
        const pendingTxs = mempool.getAndClear();
        const success = nexusChain.addBlock(pendingTxs);
        
        if (success) {
            console.log(chalk.green.bold(`[CHAIN] Auto-mined Block ${nexusChain.getLatestBlock().index}.`));
            updateMarketEconomics(); // Update price after block is mined
        } else {
            console.log(chalk.red(`[AUTO-MINER] Block validation failed.`));
            // Return to mempool if failed (simplified handling)
            pendingTxs.forEach(tx => mempool.addTransaction(tx));
        }
    }
}, 10000); // Mines every 10 seconds if mempool has transactions

// ======================== CORS MIDDLEWARE ========================
app.use(cors()); 
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(bodyParser.json());

// ======================== ROUTES ========================

// 1. Root / Health Check
app.get('/', (req, res) => {
  res.json({ status: "Scientific Nexus DataChain API Node is ONLINE", network: "SYRPTS" });
});

// Get the full DataChain ledger
app.get('/blocks', (req, res) => {
  res.json(nexusChain.chain);
});

// Get balance for an address
app.get('/balance/:address', (req, res) => {
  const address = req.params.address;
  const balance = nexusChain.getBalance(address);
  res.json({ address, balance });
});

// NEW: Unified Global Stats Endpoint (Fixes Price & Cap Resets)
app.get('/stats', (req, res) => {
  const remaining = nexusChain.getRemainingSupply();
  const circulating = MAX_SUPPLY - remaining;
  const marketCap = circulating * currentPrice;
  
  res.json({ 
      maxSupply: MAX_SUPPLY,
      remainingSupply: remaining,
      circulatingSupply: circulating,
      currentPrice: currentPrice,
      marketCap: marketCap
  });
});

// Legacy Endpoint (kept for compatibility)
app.get('/supply', (req, res) => {
  const remaining = nexusChain.getRemainingSupply();
  res.json({ remainingSupply: remaining });
});

// Submit a new transaction
app.post('/tx/new', (req, res) => {
  try {
      const { from, to, amount, type } = req.body;
      const tx = { from, to, amount, type, timestamp: Date.now() };

      // Validate against current blockchain state
      const senderBalance = nexusChain.getBalance(from);
      if (!validator.validateTransaction(tx, senderBalance)) {
        return res.status(400).json({ error: "Insufficient balance or invalid transaction." });
      }

      const success = mempool.addTransaction(tx);
      if (success) {
        res.status(201).json({ message: "Transaction added to mempool. Awaiting Auto-Miner.", tx });
      } else {
        res.status(400).json({ error: "Transaction failed validation" });
      }
  } catch (error) {
      console.error(chalk.red("[TX ERROR]"), error);
      res.status(500).json({ error: "Internal Server Error during transaction processing." });
  }
});

// Manual Mining Trigger (Fallback)
app.post('/mine', (req, res) => {
  try {
      const pendingTxs = mempool.getAndClear();
      if (pendingTxs.length === 0) {
        return res.status(400).json({ error: "No pending transactions to mine." });
      }

      const success = nexusChain.addBlock(pendingTxs);
      if (success) {
        updateMarketEconomics();
        console.log(chalk.green.bold(`[CHAIN] Block ${nexusChain.getLatestBlock().index} successfully added via manual trigger.`));
        res.json({ message: "Block Mined", block: nexusChain.getLatestBlock() });
      } else {
        res.status(500).json({ error: "Fatal Error: Block validation failed during mining." });
      }
  } catch (error) {
      console.error(chalk.red("[MINE ERROR]"), error);
      res.status(500).json({ error: "Internal Server Error during mining processing." });
  }
});

// JSON 404 Catch-All
app.use((req, res) => {
  res.status(404).json({ error: "API Node Endpoint Not Found" });
});

// ======================== START SERVER ========================
app.listen(port, "0.0.0.0", () => {
  console.log(chalk.blue.bold(`--- SCIENTIFIC NEXUS API RUNNING ON PORT ${port} ---`));
  console.log(chalk.white(`Railway URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || 'Active'}`));
});
