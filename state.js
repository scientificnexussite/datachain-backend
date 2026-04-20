import pkg from 'pg';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const { Pool } = pkg;
const fixDust = (num) => Number(num.toFixed(8));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:MuTxOCYQHBfxbSgexbWOdGdbkgjBCsIv@postgres.railway.internal:5432/railway",
});

pool.query(`
    CREATE TABLE IF NOT EXISTS state_meta (
        id INT PRIMARY KEY,
        last_index INT
    );
    CREATE TABLE IF NOT EXISTS state_usd_balances (
        address VARCHAR(100) PRIMARY KEY,
        balance DOUBLE PRECISION
    );
    CREATE TABLE IF NOT EXISTS state_balances (
        address VARCHAR(100),
        token_symbol VARCHAR(20),
        balance DOUBLE PRECISION,
        PRIMARY KEY (address, token_symbol)
    );
`).catch(err => console.error(chalk.red("[DB] Failed to initialize state tables"), err));

class State {
  constructor() {
    this.balances = { "SYR": {} };     
    this.usd_balances = {}; 
    
    // Strict /app/data implementation for Railway double-backup integrity
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
    this.snapshotFile = path.join(volumePath, 'state_snapshot.json');
    
    this.isSaving = false;
    this.saveQueue = false;
  }

  getUsd(address) { 
    return this.usd_balances[address] || 0; 
  }

  addUsd(address, amount) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) return;
    const current = this.getUsd(address);
    this.usd_balances[address] = fixDust(current + amount);
  }

  deductUsd(address, amount) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) return false;
    const current = this.getUsd(address);
    if (address !== 'system' && current < amount) return false;
    this.usd_balances[address] = fixDust(current - amount);
    return true;
  }

  applyTransaction(tx, currentPrice = 0, isReplay = false) {
    const { from, to, amount, type } = tx;
    const tokenSymbol = tx.tokenSymbol || "SYR"; 
    
    if (!this.balances[tokenSymbol]) this.balances[tokenSymbol] = {};

    if (type === 'MINT') {
      this.balances[tokenSymbol][to] = fixDust((this.balances[tokenSymbol][to] || 0) + amount);
      return true;
    }

    if (type === 'USD_DEPOSIT') {
      this.addUsd(to, amount);
      return true;
    }

    if (type === 'USD_WITHDRAWAL') {
      return this.deductUsd(from, amount);
    }

    let fromBalance = this.balances[tokenSymbol][from] || 0;

    // LEGACY REPLAY PROTECTION: Infinitely fund the system wallet so old history doesn't fail math validations
    if (from === 'system' && fromBalance < amount) {
        this.balances[tokenSymbol][from] = fixDust(fromBalance + amount);
        fromBalance = this.balances[tokenSymbol][from];
    }

    if (type === 'TRANSFER') {
      if (from !== 'system' && fromBalance < amount) return false; 
      this.balances[tokenSymbol][from] = fixDust(fromBalance - amount);
      this.balances[tokenSymbol][to] = fixDust((this.balances[tokenSymbol][to] || 0) + amount);
      return true;
    }

    if (type === 'MARKET_TRADE') {
      if (from !== 'system' && fromBalance < amount) return false; 
      const tradeUsdValue = tx.amountUsd; 

      if (to !== 'system') {
          if (!isReplay) {
              if (!this.deductUsd(to, tradeUsdValue)) return false; 
          }
      }

      if (from !== 'system') {
          this.addUsd(from, tradeUsdValue);
      }

      this.balances[tokenSymbol][from] = fixDust(fromBalance - amount);
      this.balances[tokenSymbol][to] = fixDust((this.balances[tokenSymbol][to] || 0) + amount);
      return true;
    }

    return false; 
  }

  getBalance(address, tokenSymbol = "SYR") {
    if (!this.balances[tokenSymbol]) return 0;
    return this.balances[tokenSymbol][address] || 0;
  }

  async loadSnapshot(chain) {
    let startIndex = 0;
    try {
        const metaRes = await pool.query('SELECT last_index FROM state_meta WHERE id = 1');
        if (metaRes.rows.length) {
            startIndex = metaRes.rows[0].last_index + 1;
        }

        const usdRes = await pool.query('SELECT address, balance FROM state_usd_balances');
        for (const row of usdRes.rows) {
            this.usd_balances[row.address] = parseFloat(row.balance);
        }

        const balRes = await pool.query('SELECT address, token_symbol, balance FROM state_balances');
        for (const row of balRes.rows) {
            if (!this.balances[row.token_symbol]) this.balances[row.token_symbol] = {};
            this.balances[row.token_symbol][row.address] = parseFloat(row.balance);
        }
        console.log(chalk.green(`[STATE] PostgreSQL Snapshot loaded successfully. Replaying from Block ${startIndex}...`));
    } catch (e) {
        console.warn(chalk.yellow("[STATE] No valid PostgreSQL snapshot found or DB unavailable. Running full chain replay."));
        startIndex = 0;
    }

    for (let i = startIndex; i < chain.length; i++) {
      const block = chain[i];
      if (typeof block.data === 'string') continue;
      for (const tx of block.data) {
        this.applyTransaction(tx, 0, true); 
      }
    }
  }

  async saveSnapshot(lastIndex) {
      if (this.isSaving) {
          this.saveQueue = true;
          return;
      }
      this.isSaving = true;
      this.saveQueue = false;

      // Keep the local JSON snapshot as a secondary backup
      try {
          const snapshot = { balances: this.balances, usd_balances: this.usd_balances, lastIndex };
          const tempFile = this.snapshotFile + '.tmp';
          await fs.promises.writeFile(tempFile, JSON.stringify(snapshot));
          await fs.promises.rename(tempFile, this.snapshotFile);
      } catch (e) {}

      const client = await pool.connect();
      try {
          await client.query('BEGIN');
          
          await client.query('INSERT INTO state_meta (id, last_index) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET last_index = $1', [lastIndex]);
          
          for (const address in this.usd_balances) {
              await client.query(
                  'INSERT INTO state_usd_balances (address, balance) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET balance = $2',
                  [address, this.usd_balances[address]]
              );
          }

          for (const tokenSymbol in this.balances) {
              for (const address in this.balances[tokenSymbol]) {
                  await client.query(
                      'INSERT INTO state_balances (address, token_symbol, balance) VALUES ($1, $2, $3) ON CONFLICT (address, token_symbol) DO UPDATE SET balance = $3',
                      [address, tokenSymbol, this.balances[tokenSymbol][address]]
                  );
              }
          }
          
          await client.query('COMMIT');
      } catch (e) {
          await client.query('ROLLBACK');
          console.error(chalk.red("[STATE] PostgreSQL Snapshot save failed:"), e);
      } finally {
          client.release();
          this.isSaving = false;
          if (this.saveQueue) this.saveSnapshot(lastIndex);
      }
  }
}

export default State;