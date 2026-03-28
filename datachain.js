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
    this.chain = [this.createGenesisBlock()];
    this.difficulty = 2; // Adjust for faster/slower mining
    this.state = new State();
    this.state.rebuild(this.chain); // initial state from genesis
  }

  createGenesisBlock() {
    // Genesis block contains no transactions, just a string.
    return new Block(0, "03/27/2026", "Scientific Nexus Genesis Block", "0");
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  addBlock(transactions) {
    // 1. Validate all transactions against current state (simulate)
    const tempState = new State();
    tempState.balances = { ...this.state.balances };
    for (const tx of transactions) {
      if (!tempState.applyTransaction(tx)) {
        console.log(chalk.red(`[VALIDATION] Transaction invalid: ${JSON.stringify(tx)}`));
        return false;
      }
    }

    // 2. Create and mine block
    const newBlock = new Block(
      this.chain.length,
      Date.now(),
      transactions,
      this.getLatestBlock().hash
    );
    newBlock.mineBlock(this.difficulty);

    // 3. Validate block link
    if (!validator.validateBlock(newBlock, this.getLatestBlock())) {
      return false;
    }

    // 4. Add block and commit state
    this.chain.push(newBlock);
    this.state = tempState; // commit new state
    return true;
  }

  // Get balance for an address
  getBalance(address) {
    return this.state.getBalance(address);
  }

  // Get remaining supply (balance of the "system" address)
  getRemainingSupply() {
    return this.state.getBalance("system");
  }
}

export { Block, DataChain };