import fs from 'fs';
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
      this.index +
      this.previousHash +
      this.timestamp +
      JSON.stringify(this.data) +
      this.nonce
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
    this.chainFile = './chain.json';
    this.difficulty = 2;
    this.state = new State();
    this.loadChain();
  }

  // Load ledger from disk to prevent data loss on restarts
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
        this.state.rebuild(this.chain);
        console.log(chalk.green(`[DATACHAIN] Loaded ${this.chain.length} blocks from persistent storage.`));
      } else {
        this.chain = [this.createGenesisBlock()];
        this.state.rebuild(this.chain);
        this.saveChain();
      }
    } catch (err) {
      console.log(chalk.red('[DATACHAIN] Error loading chain, starting fresh.'));
      this.chain = [this.createGenesisBlock()];
      this.state.rebuild(this.chain);
    }
  }

  // Save the ledger to the disk
  saveChain() {
    try {
       fs.writeFileSync(this.chainFile, JSON.stringify(this.chain, null, 2));
    } catch(e) {
       console.log(chalk.red('[DATACHAIN] Failed to save chain to disk.'));
    }
  }

  createGenesisBlock() {
    return new Block(0, "03/27/2026", "Scientific Nexus Genesis Block", "0");
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  addBlock(transactions) {
    const tempState = new State();
    tempState.balances = { ...this.state.balances };
    for (const tx of transactions) {
      if (!tempState.applyTransaction(tx)) {
        console.log(chalk.red(`[VALIDATION] Transaction invalid: ${JSON.stringify(tx)}`));
        return false;
      }
    }

    const newBlock = new Block(
      this.chain.length,
      Date.now(),
      transactions,
      this.getLatestBlock().hash
    );
    newBlock.mineBlock(this.difficulty);

    if (!validator.validateBlock(newBlock, this.getLatestBlock())) {
      return false;
    }

    this.chain.push(newBlock);
    this.state = tempState;
    this.saveChain(); // Trigger save after successful validation
    return true;
  }

  getBalance(address) {
    return this.state.getBalance(address);
  }

  getRemainingSupply() {
    return this.state.getBalance("system");
  }
}

export { Block, DataChain };
