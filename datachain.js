import fs from 'fs';
import path from 'path';
import CryptoJS from 'crypto-js';
import chalk from 'chalk';
import validator from './validator.js';
import State from './state.js';
import config from './config.json' with { type: "json" };

class Block {
  constructor(index, timestamp, data, previousHash = '') {
    this.index = index;
    this.timestamp = timestamp;
    this.data = data;
    this.previousHash = previousHash;
    this.nonce = 0;
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return CryptoJS.SHA256(
      this.index + this.previousHash + this.timestamp + JSON.stringify(this.data) + this.nonce
    ).toString();
  }

  mineBlock(difficulty) {
    return new Promise((resolve) => {
      const target = Array(difficulty + 1).join("0");
      const mineChunk = () => {
        for (let i = 0; i < 2000; i++) {
          if (this.hash.substring(0, difficulty) === target) {
            console.log(chalk.cyan(`[DATACHAIN] Block Mined: ${this.hash}`));
            return resolve(true);
          }
          this.nonce++;
          this.hash = this.calculateHash();
        }
        setImmediate(mineChunk); 
      };
      mineChunk();
    });
  }
}

class DataChain {
  constructor() {
    this.chain = [];
    this.difficulty = 2;
    this.state = new State();
    this.priceHistoryCache = [];
    
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
    this.chainFile = path.join(volumePath, 'chain.json');
    this.backupFile = path.join(volumePath, 'chain_backup.json');
    
    this.isSaving = false;
    this.saveQueue = false;

    this.loadChain();
  }

  loadChain() {
    try {
        if (fs.existsSync(this.chainFile)) {
            const data = fs.readFileSync(this.chainFile, 'utf8');
            const parsed = JSON.parse(data);
            this.chain = parsed.map(b => {
                const block = new Block(b.index, b.timestamp, b.data, b.previousHash);
                block.nonce = b.nonce;
                block.hash = b.hash;
                return block;
            });
            this.state.loadSnapshot(this.chain);
            this.rebuildPriceHistory();
            console.log(chalk.green(`[DATACHAIN] Successfully loaded ${this.chain.length} blocks from disk.`));
        } else {
            this.chain = [this.createGenesisBlock()];
            this.rebuildPriceHistory();
        }
    } catch (e) {
        console.error(chalk.red("[DATACHAIN] Failed to load chain from disk, starting fresh."));
        this.chain = [this.createGenesisBlock()];
        this.rebuildPriceHistory();
    }
  }

  async saveChain() {
      if (this.isSaving) {
          this.saveQueue = true;
          return;
      }
      this.isSaving = true;
      this.saveQueue = false;

      try {
          const tempFile = this.chainFile + '.tmp';
          await fs.promises.writeFile(tempFile, JSON.stringify(this.chain));
          await fs.promises.rename(tempFile, this.chainFile);
          
          if (this.chain.length % 50 === 0) {
              await fs.promises.copyFile(this.chainFile, this.backupFile);
          }
      } catch (e) {
          console.error(chalk.red("[DATACHAIN] Error saving chain to disk"));
      } finally {
          this.isSaving = false;
          if (this.saveQueue) this.saveChain();
      }
  }

  createGenesisBlock() {
    return new Block(0, new Date(config.blockchain.genesis_date).getTime(), "Scientific Nexus Genesis Block", "0");
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  getRemainingSupply(tokenSymbol = "SYR") {
    let minted = 0;
    for (const block of this.chain) {
      if (typeof block.data === 'string') continue;
      for (const tx of block.data) {
        if (tx.type === 'MINT' && (tx.tokenSymbol === tokenSymbol || (!tx.tokenSymbol && tokenSymbol === "SYR"))) {
          minted += tx.amount;
        }
      }
    }
    return Math.max(0, 6000000000 - minted);
  }

  getLastMarketPrice(defaultPrice) {
      for (let i = this.chain.length - 1; i >= 0; i--) {
          const block = this.chain[i];
          if (typeof block.data === 'string') continue;
          for (let j = block.data.length - 1; j >= 0; j--) {
              const tx = block.data[j];
              if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) {
                  return tx.amountUsd / tx.amount;
              }
              if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.priceUsd) {
                  return tx.priceUsd;
              }
          }
      }
      return defaultPrice;
  }

  rebuildPriceHistory() {
      const history = [];
      history.push({ timestamp: new Date(config.blockchain.genesis_date).getTime(), price: config.blockchain.starting_price });
      for (const block of this.chain) {
          if (typeof block.data === 'string') continue;
          for (const tx of block.data) {
              if ((tx.tokenSymbol === 'SYR' || !tx.tokenSymbol)) {
                  if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) history.push({ timestamp: tx.timestamp, price: tx.amountUsd / tx.amount });
                  else if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.priceUsd) history.push({ timestamp: tx.timestamp, price: tx.priceUsd });
              }
          }
      }
      const unique = new Map();
      history.forEach(d => unique.set(Math.floor(d.timestamp / 1000), d.price));
      this.priceHistoryCache = Array.from(unique.entries())
          .map(([t, p]) => ({ timestamp: t * 1000, price: p }))
          .sort((a, b) => a.timestamp - b.timestamp);
  }

  async addBlock(transactions, currentPrice = 0) {
    if (!transactions || transactions.length === 0) return false;

    let rewardAmount = config.blockchain.reward;
    if (config.blockchain.halving_interval) {
        const halvings = Math.floor(this.chain.length / config.blockchain.halving_interval);
        rewardAmount = rewardAmount / Math.pow(2, halvings);
    }
    const remaining = this.getRemainingSupply("SYR");
    if (rewardAmount > remaining) rewardAmount = remaining;

    const rewardTx = {
        from: "system",
        to: config.blockchain.miner_address,
        amount: rewardAmount,
        type: "MINT",
        tokenSymbol: "SYR", 
        timestamp: Date.now()
    };

    const tempState = new State();
    tempState.balances = JSON.parse(JSON.stringify(this.state.balances));
    tempState.usd_balances = { ...this.state.usd_balances }; 
    
    const validTransactions = rewardAmount > 0 ? [rewardTx] : [];
    if (rewardAmount > 0) tempState.applyTransaction(rewardTx, currentPrice);

    for (const tx of transactions) {
      if (tempState.applyTransaction(tx, currentPrice)) {
        validTransactions.push(tx);
      } else {
        console.log(chalk.red(`[VALIDATION] Tx dropped due to insufficient funds/conflict: ${tx.from} -> ${tx.to}`));
      }
    }

    const newBlock = new Block(this.chain.length, Date.now(), validTransactions, this.getLatestBlock().hash);
    
    await newBlock.mineBlock(this.difficulty); 

    if (!validator.validateBlock(newBlock, this.getLatestBlock())) return false;

    this.chain.push(newBlock);
    this.state = tempState;
    
    this.adjustDifficulty();
    this.rebuildPriceHistory(); 
    await this.saveChain(); 
    return true;
  }

  getBalance(address, tokenSymbol = "SYR") { 
      return this.state.getBalance(address, tokenSymbol); 
  }

  adjustDifficulty() {
    const TARGET_TIME = 10000; 
    const ADJUSTMENT_INTERVAL = 10;

    if (this.chain.length > 0 && this.chain.length % ADJUSTMENT_INTERVAL === 0) {
      const prevAdjustmentBlock = this.chain[this.chain.length - ADJUSTMENT_INTERVAL];
      const timeExpected = TARGET_TIME * ADJUSTMENT_INTERVAL;
      const timeTaken = this.getLatestBlock().timestamp - prevAdjustmentBlock.timestamp;

      if (timeTaken < timeExpected / 2) {
        this.difficulty++;
      } else if (timeTaken > timeExpected * 2 && this.difficulty > 1) {
        this.difficulty--;
      }
      console.log(chalk.yellow(`[NETWORK] Difficulty adjusted to: ${this.difficulty}`));
    }
  }
}

export { DataChain };
