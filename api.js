import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import mempool from './mempool.js';
import { DataChain } from './datachain.js';
import validator from './validator.js';   // ✅ Import fixed

const app = express();
const port = process.env.PORT || 3001;
const nexusChain = new DataChain();

// Initialise global supply
const MAX_SUPPLY = 3000000000;
const SYSTEM_ADDRESS = "system";

if (nexusChain.getBalance(SYSTEM_ADDRESS) === 0) {
  const initTx = {
    from: "system",
    to: "system",
    amount: MAX_SUPPLY,
    type: "MINT",
    timestamp: Date.now()
  };
  nexusChain.addBlock([initTx]);
  console.log(chalk.green(`[INIT] Initial supply of ${MAX_SUPPLY} SYR allocated to system address.`));
}

app.use(cors());
app.use(bodyParser.json());

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

// Get remaining global supply
app.get('/supply', (req, res) => {
  const remaining = nexusChain.getRemainingSupply();
  res.json({ remainingSupply: remaining });
});

// Submit a new transaction
app.post('/tx/new', (req, res) => {
  const { from, to, amount, type } = req.body;
  const tx = { from, to, amount, type, timestamp: Date.now() };

  // Validate against current blockchain state
  const senderBalance = nexusChain.getBalance(from);
  if (!validator.validateTransaction(tx, senderBalance)) {
    return res.status(400).json({ error: "Insufficient balance or invalid transaction." });
  }

  const success = mempool.addTransaction(tx);
  if (success) {
    res.status(201).json({ message: "Transaction added to mempool", tx });
  } else {
    res.status(400).json({ error: "Transaction failed validation" });
  }
});

// Trigger mining of a new block
app.post('/mine', (req, res) => {
  const pendingTxs = mempool.getAndClear();
  if (pendingTxs.length === 0) {
    return res.status(400).json({ error: "No pending transactions to mine." });
  }

  const success = nexusChain.addBlock(pendingTxs);
  if (success) {
    console.log(chalk.green.bold(`[CHAIN] Block ${nexusChain.getLatestBlock().index} successfully added to DataChain.`));
    res.json({ message: "Block Mined", block: nexusChain.getLatestBlock() });
  } else {
    res.status(500).json({ error: "Fatal Error: Block validation failed during mining." });
  }
});

// Automatic mining every 10 seconds (fixed for Railway)
setInterval(async () => {
  const pendingCount = mempool.getPendingCount();
  if (pendingCount === 0) return;
  try {
    // Call the mining endpoint internally (using the same express app)
    const response = await fetch(`http://localhost:${port}/mine`, { method: 'POST' });
    if (response.ok) {
      const data = await response.json();
      console.log(chalk.blue(`[MINER] Mined block ${data.block.index} with ${data.block.data.length} txs.`));
    } else {
      const err = await response.json();
      console.log(chalk.red(`[MINER] Failed to mine: ${err.error}`));
    }
  } catch (err) {
    console.log(chalk.red(`[MINER] Error: ${err.message}`));
  }
}, 10000);

app.listen(port, () => {
  console.log(chalk.blue.bold(`--- SCIENTIFIC NEXUS API RUNNING ON PORT ${port} ---`));
});