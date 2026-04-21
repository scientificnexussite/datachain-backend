import pkg from 'pg';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const { Pool } = pkg;
const fixDust = (num) => Number(Number(num).toFixed(8));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:MuTxOCYQHBfxbSgexbWOdGdbkgjBCsIv@postgres.railway.internal:5432/railway",
});

pool.query(`
    CREATE TABLE IF NOT EXISTS state_meta (\n        id INT PRIMARY KEY,\n        last_index INT\n    );\n    CREATE TABLE IF NOT EXISTS state_usd_balances (\n        address VARCHAR(100) PRIMARY KEY,\n        balance DOUBLE PRECISION\n    );\n    CREATE TABLE IF NOT EXISTS state_balances (\n        address VARCHAR(100),\n        token_symbol VARCHAR(20),\n        balance DOUBLE PRECISION,\n        PRIMARY KEY (address, token_symbol)\n    );\n`).catch(err => console.error(chalk.red("[DB] Failed to initialize state tables"), err));

class State {
  constructor() {
    this.balances = { "SYR": {} };     
    this.usd_balances = {}; 
    
    const volumeDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
    this.snapshotFile = path.join(volumeDir, 'state_snapshot.json');
    
    this.isSaving = false;
    this.saveQueue = false;
  }

  getUsd(address) { 
    return this.usd_balances[address] || 0; 
  }

  addUsd(address, amount) {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return;
    const current = this.getUsd(address);
    this.usd_balances[address] = fixDust(current + parsedAmount);
  }

  deductUsd(address, amount) {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return false;
    const current = this.getUsd(address);
    if (address !== 'system' && current < parsedAmount) return false;
    this.usd_balances[address] = fixDust(current - parsedAmount);
    return true;
  }

  applyTransaction(tx, currentPrice = 0, isReplay = false) {
    let { from, to, type } = tx;
    
    let amount = parseFloat(tx.amount);
    if (isNaN(amount) || amount <= 0) return false;
    
    type = String(type).toUpperCase();
    const tokenSymbol = tx.tokenSymbol ? String(tx.tokenSymbol).toUpperCase() : "SYR"; 
    
    if (!this.balances[tokenSymbol]) this.balances[tokenSymbol] = {};

    if (type === 'MINT') {
      const receiver = to || from;
      this.balances[tokenSymbol][receiver] = fixDust((this.balances[tokenSymbol][receiver] || 0) + amount);
      return true;
    }

    if (type === 'USD_DEPOSIT') {
      this.addUsd(to || from, amount);
      return true;
    }

    if (type === 'USD_WITHDRAWAL') {
      return this.deductUsd(from, amount);
    }

    let sender = from;
    let receiver = to;

    if (type === 'BUY') {
        receiver = (to && to !== 'system') ? to : from; 
        sender = 'system';
    }
    else if (type === 'SELL') {
        sender = (from && from !== 'system') ? from : to;
        receiver = 'system';
    }

    let senderBalance = this.balances[tokenSymbol][sender] || 0;

    if (sender === 'system' && senderBalance < amount) {
        this.balances[tokenSymbol][sender] = fixDust(senderBalance + amount);
        senderBalance = this.balances[tokenSymbol][sender];
    }

    if (type === 'TRANSFER' || type === 'MARKET_TRADE' || type === 'BUY' || type === 'SELL') {
        if (!isReplay && sender !== 'system' && senderBalance < amount) return false; 
        
        let tradeUsdValue = parseFloat(tx.amountUsd) || 0;
        if (!tradeUsdValue && tx.priceUsd) tradeUsdValue = fixDust(amount * parseFloat(tx.priceUsd));

        if (type === 'MARKET_TRADE' || type === 'BUY' || type === 'SELL') {
            if (receiver !== 'system' && !isReplay) {
                if (!this.deductUsd(receiver, tradeUsdValue)) return false; 
            }
            if (sender !== 'system') {
                this.addUsd(sender, tradeUsdValue);
            }
        }

        this.balances[tokenSymbol][sender] = fixDust(senderBalance - amount);
        this.balances[tokenSymbol][receiver] = fixDust((this.balances[tokenSymbol][receiver] || 0) + amount);
        return true;
    }

    return false; 
  }

  getBalance(address, tokenSymbol = "SYR") {
    if (!this.balances[tokenSymbol]) return 0;
    return this.balances[tokenSymbol][address] || 0;
  }

  async loadSnapshot(chain) {
    try {
        const usdRes = await pool.query('SELECT address, balance FROM state_usd_balances');
        for (const row of usdRes.rows) {
            this.usd_balances[row.address] = parseFloat(row.balance);
        }

        const balRes = await pool.query('SELECT address, token_symbol, balance FROM state_balances');
        for (const row of balRes.rows) {
            if (!this.balances[row.token_symbol]) this.balances[row.token_symbol] = {};
            this.balances[row.token_symbol][row.address] = parseFloat(row.balance);
        }
        
        if (Object.keys(this.usd_balances).length === 0 && Object.keys(this.balances["SYR"] || {}).length === 0) {
            throw new Error("Empty Postgres State");
        }
        console.log(chalk.green(`[STATE] PostgreSQL Snapshot loaded successfully.`));
    } catch (e) {
        console.log(chalk.yellow("[STATE] Database state empty or missing. Rebuilding ledger mathematically..."));
        this.balances = { "SYR": {} };
        this.usd_balances = {};

        for (let i = 0; i < chain.length; i++) {
          const block = chain[i];
          if (typeof block.data === 'string') continue;
          for (const tx of block.data) {
            this.applyTransaction(tx, 0, true); 
          }
        }
        console.log(chalk.green(`[STATE] Mathematical replay complete.`));
    }
  }

  async saveSnapshot(lastIndex) {
      if (this.isSaving) {
          this.saveQueue = true;
          return;
      }
      this.isSaving = true;
      this.saveQueue = false;

      try {
          const volumeDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
          if (!fs.existsSync(volumeDir)) fs.mkdirSync(volumeDir, { recursive: true });
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