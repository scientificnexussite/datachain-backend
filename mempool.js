import chalk from 'chalk';
import crypto from 'crypto';

class Mempool {
  constructor() {
    this.pendingTransactions = [];
    this.MAX_MEMPOOL_SIZE = 1000; 
  }

  addTransaction(tx) {
    if (this.pendingTransactions.length >= this.MAX_MEMPOOL_SIZE) {
        console.log(chalk.red('[MEMPOOL] Rejected: Mempool is full.'));
        return false;
    }

    if (!tx.from || !tx.to || !tx.amount) {
      console.log(chalk.red('[MEMPOOL] Rejected: Invalid transaction structure.'));
      return false;
    }

    // Fix: Generate a payload hash to compare instead of relying on the timestamp
    const txHash = crypto.createHash('sha256').update(JSON.stringify({from: tx.from, to: tx.to, amount: tx.amount, type: tx.type, sig: tx.signature || 'sys'})).digest('hex');

    const isDuplicate = this.pendingTransactions.some(p => {
        const pHash = crypto.createHash('sha256').update(JSON.stringify({from: p.from, to: p.to, amount: p.amount, type: p.type, sig: p.signature || 'sys'})).digest('hex');
        return pHash === txHash;
    });
    
    if (isDuplicate) return false;

    this.pendingTransactions.push(tx);
    console.log(chalk.magenta(`[MEMPOOL] Transaction Added. Total Pending: ${this.pendingTransactions.length}`));
    return true;
  }

  getAndClear() {
    const txs = [...this.pendingTransactions];
    this.pendingTransactions = [];
    return txs;
  }

  getPendingCount() { 
    return this.pendingTransactions.length; 
  }
}

export default new Mempool();