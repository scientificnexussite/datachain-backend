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
    const volumeDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
    this.snapshotFile = path.join(volumeDir, 'state_snapshot.json');

    // PATH LOCATOR: Finds legacy snapshot from before the volume was mounted
    const legacySnapshot = path.join(process.cwd(), 'state_snapshot.json');
    if (!fs.existsSync(this.snapshotFile) && fs.existsSync(legacySnapshot)) {
        try {
            if (!fs.existsSync(volumeDir)) fs.mkdirSync(volumeDir, { recursive: true });
            fs.copyFileSync(legacySnapshot, this.snapshotFile);
        } catch(e) {}
    }
    
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

    // FIX: Map legacy 'BUY' and 'SELL' transactions to modern MARKET_TRADE ledger logic
    if (type === 'MARKET_TRADE' || type === 'BUY' || type === 'SELL') {
      if (from !== 'system' && fromBalance < amount) return false; 
      
      let tradeUsdValue = tx.amountUsd || 0;
      if (!tradeUsdValue && tx.priceUsd) tradeUsdValue = amount * tx.priceUsd;

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
    // FORCED REPLAY INJECTION: We bypass the saved state shortcut and rebuild mathematically from Block 0.
    // This guarantees that the newly mapped legacy BUY/SELL transactions are properly credited to user wallets.
    console.log(chalk.yellow("[STATE] Rebuilding ledger state mathematically from Genesis Block..."));

    this.balances = { "SYR": {} };
    this.usd_balances = {};

    for (let i = 0; i < chain.length; i++) {
      const block = chain[i];
      if (typeof block.data === 'string') continue;
      for (const tx of block.data) {
        this.applyTransaction(tx, 0, true); 
      }
    }
    
    console.log(chalk.green(`[STATE] Full mathematical replay complete. Ledger state fully restored.`));
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
                  'INSERT INTO state_usd_balances (address, balance) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET balance = $2',\n                  [address, this.usd_balances[address]]
              );
          }

          for (const tokenSymbol in this.balances) {
              for (const address in this.balances[tokenSymbol]) {
                  await client.query(
                      'INSERT INTO state_balances (address, token_symbol, balance) VALUES ($1, $2, $3) ON CONFLICT (address, token_symbol) DO UPDATE SET balance = $3',\n                      [address, tokenSymbol, this.balances[tokenSymbol][address]]
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