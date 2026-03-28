import chalk from 'chalk';

class Mempool {
  constructor() {
    this.pendingTransactions = [];
  }

  addTransaction(tx) {
    if (!tx.from || !tx.to || !tx.amount) {
      console.log(chalk.red('[MEMPOOL] Rejected: Invalid transaction structure.'));
      return false;
    }

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