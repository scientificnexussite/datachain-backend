// datachain.js
import fs from 'fs';
import path from 'path';
import CryptoJS from 'crypto-js';
import chalk from 'chalk';
import validator from './validator.js';
import State from './state.js';

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
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
    this.chainFile = path.join(volumePath, 'chain.json');
    this.backupFile = path.join(volumePath, 'chain_backup.json');
    this.tempFile = path.join(volumePath, 'chain.json.tmp'); // Security: Atomic Writes
    
    this.difficulty = 2;
    this.state = new State();
    this.loadChain();
  }

  loadChain() {
    try {
      if (fs.existsSync(this.chainFile)) {
        const data = fs.readFileSync(this.chainFile, 'utf8');
        const parsed = JSON.parse(data);
        
        let chainArray = Array.isArray(parsed) ? parsed : (parsed.chain || []);
        let loadedUsd = Array.isArray(parsed) ? {} : (parsed.usdBalances || {});

        this.chain = chainArray.map(b => {
           const block = new Block(b.index, b.timestamp, b.data, b.previousHash);
           block.nonce = b.nonce;
           block.hash = b.hash;
           return block;
        });
        
        this.state.rebuild(this.chain);
        this.state.usd_balances = loadedUsd;
      } else {
        this.chain = [this.createGenesisBlock()];
        this.state.rebuild(this.chain);
        this.saveChain();
      }
    } catch (err) {
      console.log(chalk.red('[DATACHAIN] Main chain load failed. Attempting backup recovery...'));
      try {
          if (fs.existsSync(this.backupFile)) {
             const data = fs.readFileSync(this.backupFile, 'utf8');
             const parsed = JSON.parse(data);
             
             let chainArray = Array.isArray(parsed) ? parsed : (parsed.chain || []);
             let loadedUsd = Array.isArray(parsed) ? {} : (parsed.usdBalances || {});

             this.chain = chainArray.map(b => {
                 const block = new Block(b.index, b.timestamp, b.data, b.previousHash);
                 block.nonce = b.nonce;
                 block.hash = b.hash;
                 return block;
             });
             this.state.rebuild(this.chain);
             this.state.usd_balances = loadedUsd;
          } else {
             throw new Error("No backup found.");
          }
      } catch (backupErr) {
          console.log(chalk.red('[DATACHAIN] Total failure. Starting fresh ledger.'));
          this.chain = [this.createGenesisBlock()];
          this.state.rebuild(this.chain);
          this.saveChain();
      }
    }
  }

  saveChain() {
    try {
       // Backup old chain
       if (fs.existsSync(this.chainFile)) fs.copyFileSync(this.chainFile, this.backupFile);
       
       const dataToSave = { chain: this.chain, usdBalances: this.state.usd_balances };
       
       // SECURITY: Atomic File Writing. Write to temp, then rename.
       // Prevents JSON corruption if the node crashes exactly during fs.writeFileSync
       fs.writeFileSync(this.tempFile, JSON.stringify(dataToSave, null, 2));
       fs.renameSync(this.tempFile, this.chainFile);
       
    } catch(e) {
       console.log(chalk.red(`[DATACHAIN] Failed to save chain: ${e.message}`));
    }
  }

  createGenesisBlock() { return new Block(0, "03/27/2026", "Scientific Nexus Genesis Block", "0"); }
  getLatestBlock() { return this.chain[this.chain.length - 1]; }

  addBlock(transactions, currentPrice = 0) {
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
    this.saveChain(); 
    return true;
  }

  getBalance(address) { return this.state.getBalance(address); }
  getRemainingSupply() { return this.state.getBalance("system"); }
}

export { Block, DataChain };
