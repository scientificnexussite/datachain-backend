import chalk from 'chalk';
import crypto from 'crypto';
import pool from './db.js'; // Issue #3 Fixed

pool.query(`
    CREATE TABLE IF NOT EXISTS mempool_store (
        hash VARCHAR(64) PRIMARY KEY,
        tx_data JSONB
    );
`).catch(err => console.error(chalk.red("[DB] Mempool init failed"), err));

class Mempool {
  constructor() {
    this.pendingTransactions = [];
    this.MAX_MEMPOOL_SIZE = 5000; 
    this.loadMempool();
  }

  async loadMempool() {
      try {
          const res = await pool.query('SELECT tx_data FROM mempool_store');
          this.pendingTransactions = res.rows.map(row => row.tx_data);
          if (this.pendingTransactions.length > 0) {
              console.log(chalk.green(`[MEMPOOL] Restored ${this.pendingTransactions.length} pending transactions from Database.`));
          }
      } catch(e) {}
  }

  async addTransaction(tx) {
    if (this.pendingTransactions.length >= this.MAX_MEMPOOL_SIZE) {
        console.log(chalk.red('[MEMPOOL] Rejected: Mempool is full.'));
        return false;
    }

    if (!tx.from || !tx.to || !tx.amount) {
      console.log(chalk.red('[MEMPOOL] Rejected: Invalid transaction structure.'));
      return false;
    }

    if (tx.signature && tx.signature !== 'sys') {
        try {
            const dbCheck = await pool.query('SELECT 1 FROM transactions WHERE signature = $1 LIMIT 1', [tx.signature]);
            if (dbCheck.rows.length > 0) {
                console.log(chalk.red.bold('[SECURITY] REPLAY ATTACK BLOCKED: Transaction signature already exists in ledger.'));
                return false;
            }
        } catch(e) {}
    }

    const txHash = crypto.createHash('sha256').update(JSON.stringify({from: tx.from, to: tx.to, amount: tx.amount, type: tx.type, sig: tx.signature || 'sys'})).digest('hex');

    const isDuplicate = this.pendingTransactions.some(p => {
        const pHash = crypto.createHash('sha256').update(JSON.stringify({from: p.from, to: p.to, amount: p.amount, type: p.type, sig: p.signature || 'sys'})).digest('hex');
        return pHash === txHash;
    });
    
    if (isDuplicate) return false;

    this.pendingTransactions.push(tx);
    
    pool.query('INSERT INTO mempool_store (hash, tx_data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [txHash, tx]).catch(()=>{});

    console.log(chalk.magenta(`[MEMPOOL] Transaction Added. Total Pending: ${this.pendingTransactions.length}`));
    return true;
  }

  getPendingUsdSpend(address) {
      return this.pendingTransactions.reduce((sum, tx) => {
          if (tx.from === address && tx.type === 'USD_WITHDRAWAL') return sum + tx.amount;
          if (tx.to === address && tx.type === 'MARKET_TRADE') return sum + (tx.amountUsd || 0); 
          return sum;
      }, 0);
  }

  getPendingTokenSpend(address, tokenSymbol = "SYR") {
      return this.pendingTransactions.reduce((sum, tx) => {
          const sym = tx.tokenSymbol || "SYR";
          if (sym !== tokenSymbol) return sum;
          if (tx.from === address && tx.type === 'TRANSFER') return sum + tx.amount;
          if (tx.from === address && tx.type === 'MARKET_TRADE') return sum + tx.amount; 
          return sum;
      }, 0);
  }
  
  getPendingCount() {
      return this.pendingTransactions.length;
  }

  getAndClear() {
      const currentTxs = [...this.pendingTransactions];
      this.pendingTransactions = [];
      pool.query('TRUNCATE mempool_store').catch(()=>{});
      return currentTxs;
  }
}

export default new Mempool();