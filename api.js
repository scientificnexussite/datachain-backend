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

// Initialise global supply
const MAX_SUPPLY = 3000000000;
const SYSTEM_ADDRESS = "system";

// Ensure system has the initial supply on startup
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

app.use(cors());
app.use(bodyParser.json());

// --- ROUTES ---

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

// FIXED: Returns remaining global supply from the system address
app.get('/supply', (req, res) => {
  const supply = nexusChain.getBalance(SYSTEM_ADDRESS);
  res.json({ supply });
});

// ADDED/FIXED: Receives transactions from Syrpts.html
app.post('/transaction', (req, res) => {
  const tx = req.body;
  
  if (!tx.from || !tx.to || !tx.amount) {
      return res.status(400).json({ error: "Invalid transaction data. Requires from, to, and amount." });
  }

  const success = mempool.addTransaction({
      ...tx,
      timestamp: Date.now()
  });

  if (success) {
      console.log(chalk.cyan(`[API] Transaction received: ${tx.from} -> ${tx.to} (${tx.amount} SYR)`));
      res.json({ message: "Transaction added to mempool", tx });
  } else {
      res.status(400).json({ error: "Transaction failed validation (Insufficient funds or invalid amount)." });
  }
});

// Trigger mining of a new block
app.post('/mine', (req, res) => {
  mineNewBlock();
  res.json({ message: "Mining triggered", currentBlock: nexusChain.getLatestBlock().index });
});

// --- CORE LOGIC ---

// FIXED: Helper function to mine without using internal 'fetch'
function mineNewBlock() {
    const pendingTxs = mempool.getAndClear();
    if (pendingTxs.length === 0) return false;

    const success = nexusChain.addBlock(pendingTxs);
    if (success) {
        console.log(chalk.green.bold(`[CHAIN] Block ${nexusChain.getLatestBlock().index} successfully added with ${pendingTxs.length} txs.`));
        return true;
    } else {
        console.log(chalk.red(`[CHAIN] Block validation failed.`));
        return false;
    }
}

// Automatic mining every 10 seconds (Direct call logic)
setInterval(() => {
  const pendingCount = mempool.getPendingCount();
  if (pendingCount > 0) {
      console.log(chalk.blue(`[AUTO-MINER] Processing ${pendingCount} transactions...`));
      mineNewBlock();
  }
}, 10000);

app.listen(port, () => {
  console.log(chalk.yellow.bold(`\nDataChain API Online`));
  console.log(chalk.white(`Railway URL: ${process.env.RAILWAY_STATIC_URL || 'localhost'}`));
  console.log(chalk.white(`Port: ${port}`));
});
