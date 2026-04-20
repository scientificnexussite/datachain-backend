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
    let loadedPrimary = false;
    
    if (fs.existsSync(this.chainFile)) {
        try {
            const data = fs.readFileSync(this.chainFile, 'utf8');
            JSON.parse(data); 
            loadedPrimary = true;
        } catch (e) {
            console.error(chalk.red("[DATACHAIN] chain.json is corrupted. Attempting backup recovery..."));
        }
    }

    let targetFile = loadedPrimary ? this.chainFile : this.backupFile;

    try {
        if (fs.existsSync(targetFile)) {
            const data = fs.readFileSync(targetFile, 'utf8');
            const parsed = JSON.parse(data);
            this.chain = parsed.map(b => {
                const block = new Block(b.index, b.timestamp, b.data, b.previousHash);
                block.nonce = b.nonce;
                block.hash = b.hash;
                return block;
            });
            
            this.state.loadSnapshot(this.chain);
            this.rebuildPriceHistory();
            this.recalculateDifficulty();
            
            console.log(chalk.green(`[DATACHAIN] Successfully loaded ${this.chain.length} blocks.`));
            return;
        }
    } catch (e) {
        console.error(chalk.red("[DATACHAIN] Critical Error: Backup is also missing or corrupted."));
    }

    console.warn(chalk.yellow("[DATACHAIN] Starting fresh chain from genesis."));
    this.chain = [this.createGenesisBlock()];
    this.rebuildPriceHistory();
    this.difficulty = 2;
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
          
          await fs.promises.copyFile(this.chainFile, this.backupFile);
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
    if (tokenSymbol !== "SYR") return 0;
    
    // Dynamically calculate circulating supply to account for legacy MINT blocks
    let totalCirculating = 0;
    const syrBalances = this.state.balances["SYR"] || {};
    
    for (const address in syrBalances) {
        if (address !== "system") {
            totalCirculating += syrBalances[address];
        }
    }
    
    return Math.max(0, 6000000000 - totalCirculating);
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

  appendPriceHistory(block) {
      if (typeof block.data === 'string') return;
      let added = false;
      for (const tx of block.data) {
          if ((tx.tokenSymbol === 'SYR' || !tx.tokenSymbol)) {
              if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) {
                  this.priceHistoryCache.push({ timestamp: tx.timestamp, price: tx.amountUsd / tx.amount });
                  added = true;
              } else if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.priceUsd) {
                  this.priceHistoryCache.push({ timestamp: tx.timestamp, price: tx.priceUsd });
                  added = true;
              }
          }
      }
      if (added) {
          const unique = new Map();
          this.priceHistoryCache.forEach(d => unique.set(Math.floor(d.timestamp / 1000), d.price));
          this.priceHistoryCache = Array.from(unique.entries())
              .map(([t, p]) => ({ timestamp: t * 1000, price: p }))
              .sort((a, b) => a.timestamp - b.timestamp);
      }
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
        type: "TRANSFER",
        tokenSymbol: "SYR", 
        timestamp: Date.now(),
        isSystemGenerated: true
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
    this.appendPriceHistory(newBlock); 
    await this.saveChain(); 
    this.state.saveSnapshot(this.chain.length - 1); 
    
    return true;
  }

  getBalance(address, tokenSymbol = "SYR") { 
      return this.state.getBalance(address, tokenSymbol); 
  }

  recalculateDifficulty() {
    const TARGET_TIME = 10000;
    const ADJUSTMENT_INTERVAL = 10;
    this.difficulty = 2;
    for (let i = ADJUSTMENT_INTERVAL; i < this.chain.length; i += ADJUSTMENT_INTERVAL) {
        const prev = this.chain[i - ADJUSTMENT_INTERVAL];
        const curr = this.chain[i];
        const timeTaken = curr.timestamp - prev.timestamp;
        const timeExpected = TARGET_TIME * ADJUSTMENT_INTERVAL;
        if (timeTaken < timeExpected / 2) this.difficulty++;
        else if (timeTaken > timeExpected * 2 && this.difficulty > 1) this.difficulty--;
    }
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