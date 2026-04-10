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
    const target = Array(difficulty + 1).join("0");
    while (this.hash.substring(0, difficulty) !== target) {
      this.nonce++;
      this.hash = this.calculateHash();
    }
    console.log(chalk.cyan(`[DATACHAIN] Block Mined: ${this.hash}`));
  }
}

class DataChain {
  constructor() {
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
    
    this.chainFile = path.join(volumePath, 'chain.json');
    this.backupFile = path.join(volumePath, 'chain_backup.json');
    this.tempFile = path.join(volumePath, 'chain.json.tmp'); 
    
    this.difficulty = 2;
    this.difficultyAdjustmentInterval = 100; 
    this.targetBlockTime = 10000;  
    this.state = new State();
    
    this.loadChain();
  }

  loadChain() {
    try {
      if (fs.existsSync(this.chainFile)) {
        const data = fs.readFileSync(this.chainFile, 'utf8');
        const parsed = JSON.parse(data);
        
        let chainArray = Array.isArray(parsed) ? parsed : (parsed.chain || []);
        
        if (!Array.isArray(parsed) && parsed.difficulty) {
            this.difficulty = parsed.difficulty;
        }

        this.chain = chainArray.map(b => {
           const block = new Block(b.index, b.timestamp, b.data, b.previousHash);
           block.nonce = b.nonce;
           block.hash = b.hash;
           return block;
        });
        
        this.state.rebuild(this.chain);

        // --- LEGACY MIGRATION: CRITICAL FIX FOR MISSING BALANCES ---
        // Restore USD and SYR balances from the old chain.json structure so historical replay failures don't wipe them.
        if (!Array.isArray(parsed) && parsed.usd_balances) {
            Object.assign(this.state.usd_balances, parsed.usd_balances);
        }
        // Only override SYR balances if we don't have a modern snapshot to ensure integrity
        if (!Array.isArray(parsed) && parsed.balances && !fs.existsSync(this.state.snapshotFile)) {
            Object.assign(this.state.balances, parsed.balances);
        }

      } else {
        this.chain = [this.createGenesisBlock()];
        this.state.rebuild(this.chain);
        this.saveChain();
      }
    } catch (err) {
      console.log(chalk.red('[DATACHAIN] Main chain load failed. Attempting backup recovery...'));
      this.chain = [this.createGenesisBlock()];
      this.state.rebuild(this.chain);
      this.saveChain();
    }
  }

  saveChain() {
    try {
       if (fs.existsSync(this.chainFile)) {
           fs.copyFileSync(this.chainFile, this.backupFile);
       }
       const dataToSave = { 
           chain: this.chain, 
           difficulty: this.difficulty 
       };
       fs.writeFileSync(this.tempFile, JSON.stringify(dataToSave, null, 2));
       fs.renameSync(this.tempFile, this.chainFile);
       
       if (this.chain.length % 1000 === 0) {
           this.state.saveSnapshot(this.chain.length - 1);
       }
    } catch(e) {
       console.log(chalk.red(`[DATACHAIN] Failed to save chain: ${e.message}`));
    }
  }

  createGenesisBlock() { 
      return new Block(0, "03/27/2026", "Scientific Nexus Genesis Block", "0"); 
  }
  
  getLatestBlock() { 
      return this.chain[this.chain.length - 1]; 
  }

  getLastMarketPrice(defaultPrice = config.blockchain.starting_price) {
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const block = this.chain[i];
      if (typeof block.data === 'string') continue;
      for (let j = block.data.length - 1; j >= 0; j--) {
        const tx = block.data[j];
        if ((tx.type === 'MARKET_TRADE' || tx.type === 'BUY' || tx.type === 'SELL') && tx.amountUsd && tx.amount) {
          return tx.amountUsd / tx.amount;
        }
      }
    }
    return defaultPrice;
  }

  adjustDifficulty() {
      if (this.chain.length % this.difficultyAdjustmentInterval === 0 && this.chain.length >= this.difficultyAdjustmentInterval) {
          const previousAdjustmentBlock = this.chain[this.chain.length - this.difficultyAdjustmentInterval];
          const latestBlock = this.getLatestBlock();
          const timeExpected = this.difficultyAdjustmentInterval * this.targetBlockTime;
          const timeTaken = latestBlock.timestamp - previousAdjustmentBlock.timestamp;

          if (timeTaken < timeExpected / 2) {
              this.difficulty++;
              console.log(chalk.yellow(`[NETWORK] Difficulty increased to ${this.difficulty}`));
          } else if (timeTaken > timeExpected * 2 && this.difficulty > 1) {
              this.difficulty--;
              console.log(chalk.yellow(`[NETWORK] Difficulty decreased to ${this.difficulty}`));
          }
      }
  }

  addBlock(transactions, currentPrice = 0) {
    if (!transactions || transactions.length === 0) return false;

    const rewardTx = {
        from: "system",
        to: config.blockchain.miner_address,
        amount: config.blockchain.reward,
        type: "MINT",
        timestamp: Date.now()
    };
    transactions.push(rewardTx);

    const tempState = new State();
    tempState.balances = { ...this.state.balances };
    tempState.usd_balances = { ...this.state.usd_balances }; 
    
    for (const tx of transactions) {
      if (!tempState.applyTransaction(tx, currentPrice)) {
        console.log(chalk.red(`[VALIDATION] Transaction rejected in state simulation: ${JSON.stringify(tx)}`));
        return false;
      }
    }

    const newBlock = new Block(this.chain.length, Date.now(), transactions, this.getLatestBlock().hash);
    newBlock.mineBlock(this.difficulty);

    if (!validator.validateBlock(newBlock, this.getLatestBlock())) return false;

    this.chain.push(newBlock);
    this.state = tempState;
    
    this.adjustDifficulty();
    this.saveChain(); 
    return true;
  }

  getBalance(address) { return this.state.getBalance(address); }
  getRemainingSupply() { return this.state.getBalance("system"); }
}

export { Block, DataChain };
