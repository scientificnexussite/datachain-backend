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
        // Reduced to 500 to prevent CPU event-loop starvation during high difficulty
        for (let i = 0; i < 500; i++) {
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
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
    
    this.chainFile = path.join(volumePath, 'chain.json');
    this.backupFile = path.join(volumePath, 'chain_backup.json');
    this.tempFile = path.join(volumePath, 'chain.json.tmp'); 
    
    this.difficulty = 2;
    this.difficultyAdjustmentInterval = 100; 
    this.targetBlockTime = 10000;  
    this.state = new State();
    
    this.isSaving = false;
    this.saveQueue = false;

    this.loadChain();
  }

  loadChain() {
    try {
      if (fs.existsSync(this.chainFile)) {
        const data = fs.readFileSync(this.chainFile, 'utf8');
        const parsed = JSON.parse(data);
        
        let chainArray = Array.isArray(parsed) ? parsed : (parsed.chain || []);
        if (!Array.isArray(parsed) && parsed.difficulty) this.difficulty = parsed.difficulty;

        this.chain = chainArray.map(b => {
           const block = new Block(b.index, b.timestamp, b.data, b.previousHash);
           block.nonce = b.nonce;
           block.hash = b.hash;
           return block;
        });
        
        this.state.rebuild(this.chain);

        if (!Array.isArray(parsed) && parsed.usd_balances) {
            Object.assign(this.state.usd_balances, parsed.usd_balances);
        }
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

  async saveChain() {
    if (this.isSaving) {
        this.saveQueue = true;
        return;
    }
    this.isSaving = true;
    this.saveQueue = false;

    try {
       try {
           await fs.promises.access(this.chainFile);
           await fs.promises.copyFile(this.chainFile, this.backupFile);
       } catch (err) {}
       
       const dataToSave = { chain: this.chain, difficulty: this.difficulty };
       await fs.promises.writeFile(this.tempFile, JSON.stringify(dataToSave, null, 2));
       await fs.promises.rename(this.tempFile, this.chainFile);
       
       if (this.chain.length % 100 === 0) {
           await this.state.saveSnapshot(this.chain.length - 1);
       }
    } catch(e) {
       console.log(chalk.red(`[DATACHAIN] Failed to save chain: ${e.message}`));
    } finally {
       this.isSaving = false;
       if (this.saveQueue) this.saveChain();
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
          const prev = this.chain[this.chain.length - this.difficultyAdjustmentInterval];
          const latest = this.getLatestBlock();
          const timeExpected = this.difficultyAdjustmentInterval * this.targetBlockTime;
          const timeTaken = latest.timestamp - prev.timestamp;

          if (timeTaken < timeExpected / 2) {
              this.difficulty++;
              console.log(chalk.yellow(`[NETWORK] Difficulty increased to ${this.difficulty}`));
          } else if (timeTaken > timeExpected * 2 && this.difficulty > 1) {
              this.difficulty--;
              console.log(chalk.yellow(`[NETWORK] Difficulty decreased to ${this.difficulty}`));
          }
      }
  }

  async addBlock(transactions, currentPrice = 0) {
    if (!transactions || transactions.length === 0) return false;

    const rewardTx = {
        from: "system",
        to: config.blockchain.miner_address,
        amount: config.blockchain.reward,
        type: "MINT",
        tokenSymbol: "SYR", 
        timestamp: Date.now()
    };

    const tempState = new State();
    tempState.balances = JSON.parse(JSON.stringify(this.state.balances));
    tempState.usd_balances = { ...this.state.usd_balances }; 
    
    const validTransactions = [rewardTx];
    tempState.applyTransaction(rewardTx, currentPrice);

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
    await this.saveChain(); 
    return true;
  }

  getBalance(address, tokenSymbol = "SYR") { 
      return this.state.getBalance(address, tokenSymbol); 
  }
  
  getRemainingSupply(tokenSymbol = "SYR") { 
      return this.state.getBalance("system", tokenSymbol); 
  }
}

export { Block, DataChain };