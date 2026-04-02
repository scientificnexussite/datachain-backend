import chalk from 'chalk';

class Mempool {
  constructor() {
    this.pendingTransactions = [];
    this.MAX_MEMPOOL_SIZE = 1000; // Security: Prevent Memory DDoS
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

    // Security: Basic duplicate prevention
    const isDuplicate = this.pendingTransactions.some(p => 
        p.from === tx.from && p.to === tx.to && p.amount === tx.amount && p.timestamp === tx.timestamp
    );
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

  getPendingCount() { return this.pendingTransactions.length; }
}

export default new Mempool();
