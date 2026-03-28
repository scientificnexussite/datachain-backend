import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import mempool from './mempool.js';
import { DataChain } from './datachain.js';

const app = express();
const port = process.env.PORT || 3001;
const nexusChain = new DataChain();

// Initialise global supply
// The "system" address holds the total supply; we give it the max supply on startup.
// In a real system, this would be set in the genesis block.
const MAX_SUPPLY = 3000000000; // 3 billion SYR
const SYSTEM_ADDRESS = "system";

// If the system address has no balance, initialise it.
if (nexusChain.getBalance(SYSTEM_ADDRESS) === 0) {
  // Create a dummy transaction to set supply
  // But since we can't modify the genesis block after creation, we just set it directly.
  // For a production chain, this should be part of the genesis configuration.
  // We'll use a special initialisation routine.
  // However, we can't change the chain after creation, so we'll add a special block on first run.
  // But for simplicity, we'll just set the state directly.
  // Note: This is not persistent across restarts unless saved. For demo, we'll create a block with a system mint.
  const initTx = {
    from: "system",
    to: "system",
    amount: MAX_SUPPLY,
    type: "MINT",
    timestamp: Date.now()
  };
  // Add block with this transaction
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

  // Additional validation for supply: if from is "system", amount must not exceed remaining supply
  // This is already handled by the balance check (system has the remaining supply)
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

// Automatic mining every 10 seconds
setInterval(async () => {
  const pendingCount = mempool.getPendingCount();
  if (pendingCount === 0) return;
  try {
    // Use fetch to call ourselves
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