import chalk from 'chalk';
import crypto from 'crypto';
import pool from './db.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
pool.query(`
    CREATE TABLE IF NOT EXISTS mempool_store (
        hash VARCHAR(64) PRIMARY KEY,
        tx_data JSONB
    );
`).catch(err => console.error(chalk.red('[DB] Mempool table init failed'), err));

// ─── Mempool ──────────────────────────────────────────────────────────────────
class Mempool {
  constructor() {
    this.pendingTransactions = [];
    this.MAX_MEMPOOL_SIZE = 5000;
    this.loadMempool();
  }

  // ── Persistence: restore mempool from DB on boot ───────────────────────────
  async loadMempool() {
    try {
      const res = await pool.query('SELECT tx_data FROM mempool_store');
      this.pendingTransactions = res.rows.map(row => row.tx_data);
      if (this.pendingTransactions.length > 0) {
        console.log(chalk.green(`[MEMPOOL] Restored ${this.pendingTransactions.length} pending transactions from PostgreSQL.`));
      }
    } catch (e) {
      console.warn(chalk.yellow('[MEMPOOL] Could not load from DB — starting empty.'));
    }
  }

  // ── Add a new transaction ──────────────────────────────────────────────────
  async addTransaction(tx) {
    if (this.pendingTransactions.length >= this.MAX_MEMPOOL_SIZE) {
      console.log(chalk.red('[MEMPOOL] Rejected: Mempool is at capacity.'));
      return false;
    }

    if (!tx.from || !tx.to || !tx.amount) {
      console.log(chalk.red('[MEMPOOL] Rejected: Invalid transaction structure (missing from/to/amount).'));
      return false;
    }

    if (tx.signature && tx.signature !== 'sys') {
      try {
        const dbCheck = await pool.query(
          'SELECT 1 FROM transactions WHERE signature = $1 LIMIT 1',
          [tx.signature]
        );
        if (dbCheck.rows.length > 0) {
          console.log(chalk.red.bold('[SECURITY] REPLAY ATTACK BLOCKED: Transaction signature already exists in ledger.'));
          return false;
        }
      } catch (e) {}
    }

    const txHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        from: tx.from, to: tx.to, amount: tx.amount, type: tx.type, sig: tx.signature || 'sys'
      }))
      .digest('hex');

    const isDuplicate = this.pendingTransactions.some(p => {
      const pHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({
          from: p.from, to: p.to, amount: p.amount, type: p.type, sig: p.signature || 'sys'
        }))
        .digest('hex');
      return pHash === txHash;
    });

    if (isDuplicate) {
      console.log(chalk.yellow('[MEMPOOL] Duplicate transaction ignored.'));
      return false;
    }

    this.pendingTransactions.push(tx);

    pool.query(
      'INSERT INTO mempool_store (hash, tx_data) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [txHash, tx]
    ).catch(() => {});

    console.log(chalk.magenta(`[MEMPOOL] Transaction Added (+1). Total Pending: ${this.pendingTransactions.length}`));
    return true;
  }

  // ── LIMITATION 5 FIX: Atomic Batch Processing for Swaps/Conversions ────────
  async addTransactionBatch(txArray) {
    if (!Array.isArray(txArray) || txArray.length === 0) return false;

    // Check capacity for the entire batch
    if (this.pendingTransactions.length + txArray.length > this.MAX_MEMPOOL_SIZE) {
      console.log(chalk.red('[MEMPOOL] Batch Rejected: Mempool capacity exceeded.'));
      return false;
    }

    // PRE-FLIGHT CHECK: Validate every transaction in the batch first
    for (const tx of txArray) {
      if (!tx.from || !tx.to || !tx.amount) {
        console.log(chalk.red('[MEMPOOL] Batch Rejected: Malformed transaction in batch.'));
        return false;
      }

      if (tx.signature && tx.signature !== 'sys') {
        try {
          const dbCheck = await pool.query(
            'SELECT 1 FROM transactions WHERE signature = $1 LIMIT 1',
            [tx.signature]
          );
          if (dbCheck.rows.length > 0) {
            console.log(chalk.red.bold('[SECURITY] BATCH REJECTED: Replay attack detected.'));
            return false;
          }
        } catch (e) {}
      }

      const txHash = crypto.createHash('sha256').update(JSON.stringify({
        from: tx.from, to: tx.to, amount: tx.amount, type: tx.type, sig: tx.signature || 'sys'
      })).digest('hex');

      const isDuplicate = this.pendingTransactions.some(p => {
        const pHash = crypto.createHash('sha256').update(JSON.stringify({
          from: p.from, to: p.to, amount: p.amount, type: p.type, sig: p.signature || 'sys'
        })).digest('hex');
        return pHash === txHash;
      });

      if (isDuplicate) {
        console.log(chalk.yellow('[MEMPOOL] Batch Rejected: Duplicate transaction found.'));
        return false;
      }
    }

    // ALL CLEAR: Commit the entire batch to the mempool
    for (const tx of txArray) {
      this.pendingTransactions.push(tx);
      const txHash = crypto.createHash('sha256').update(JSON.stringify({
        from: tx.from, to: tx.to, amount: tx.amount, type: tx.type, sig: tx.signature || 'sys'
      })).digest('hex');

      pool.query(
        'INSERT INTO mempool_store (hash, tx_data) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [txHash, tx]
      ).catch(() => {});
    }

    console.log(chalk.magenta(`[MEMPOOL] Atomic Batch Added (+${txArray.length}). Total Pending: ${this.pendingTransactions.length}`));
    return true;
  }

  // ── FIX 2 — Restore a batch of previously-cleared transactions ────────────
  restoreTransactions(txArray) {
    if (!Array.isArray(txArray) || txArray.length === 0) return;

    let restored = 0;
    for (const tx of txArray) {
      const alreadyPresent = this.pendingTransactions.some(
        p => p.from === tx.from && p.to === tx.to && p.amount === tx.amount && p.type === tx.type
      );
      if (!alreadyPresent) {
        this.pendingTransactions.push(tx);
        restored++;

        const txHash = crypto
          .createHash('sha256')
          .update(JSON.stringify({
            from: tx.from, to: tx.to, amount: tx.amount, type: tx.type, sig: tx.signature || 'sys'
          }))
          .digest('hex');

        pool.query(
          'INSERT INTO mempool_store (hash, tx_data) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [txHash, tx]
        ).catch(() => {});
      }
    }

    if (restored > 0) {
      console.log(chalk.yellow(`[MEMPOOL] Restored ${restored} transaction(s) after mining failure. Total Pending: ${this.pendingTransactions.length}`));
    }
  }

  getPendingUsdSpend(address) {
    return this.pendingTransactions.reduce((sum, tx) => {
      if (tx.from === address && tx.type === 'USD_WITHDRAWAL') return sum + tx.amount;
      if (tx.to === address && tx.type === 'MARKET_TRADE') return sum + (tx.amountUsd || 0);
      return sum;
    }, 0);
  }

  getPendingTokenSpend(address, tokenSymbol = 'SYR') {
    return this.pendingTransactions.reduce((sum, tx) => {
      const sym = tx.tokenSymbol || 'SYR';
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
    pool.query('TRUNCATE mempool_store').catch(() => {});
    return currentTxs;
  }
}

export default new Mempool();