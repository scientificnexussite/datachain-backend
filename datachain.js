import fs from 'fs';
import path from 'path';
import CryptoJS from 'crypto-js';
import chalk from 'chalk';
import validator from './validator.js';
import State from './state.js';
import config from './config.json' with { type: "json" };
import pkg from 'pg';

const { Pool } = pkg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:MuTxOCYQHBfxbSgexbWOdGdbkgjBCsIv@postgres.railway.internal:5432/railway",
});

pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
        index INT PRIMARY KEY,
        timestamp_ms BIGINT,
        previous_hash VARCHAR(64),
        hash VARCHAR(64),
        nonce INT
    );
    CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        block_index INT,
        from_address VARCHAR(100),
        to_address VARCHAR(100),
        amount DOUBLE PRECISION,
        amount_usd DOUBLE PRECISION,
        type VARCHAR(50),
        token_symbol VARCHAR(20),
        timestamp_ms BIGINT,
        is_system_generated BOOLEAN,
        signature TEXT,
        public_key TEXT,
        platform_type VARCHAR(50),
        description TEXT
    );
`).catch(err => console.error(chalk.red("[DB] Blocks init failed"), err));

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
      this.index + this.previousHash + this.timestamp + JSON.stringify(this.data) + this.nonce
    ).toString();
  }

  mineBlock(difficulty) {
    return new Promise((resolve) => {
      const target = Array(difficulty + 1).join("0");
      const mineChunk = () => {
        for (let i = 0; i < 2000; i++) {
          if (this.hash.substring(0, difficulty) === target) {
            console.log(chalk.cyan(`[DATACHAIN] Block Mined: ${this.hash}`));
            return resolve(true);
          }
          this.nonce++;
          this.hash = this.calculateHash();
        }
        setImmediate(mineChunk); 
      };
      mineChunk();
    });
  }
}

class DataChain {
  constructor() {
    this.chain = [];
    this.difficulty = 2;
    this.state = new State();
    this.priceHistoryCache = [];
    
    this.volumeDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
    this.chainFile = path.join(this.volumeDir, 'chain.json');
    this.backupFile = path.join(this.volumeDir, 'chain_backup.json');
    
    this.isSaving = false;
    this.saveQueue = false;

    this.isInitializing = this.loadChain();
  }

  async loadChain() {
    let dbBlockCount = 0;
    try {
        const countRes = await pool.query('SELECT COUNT(*) FROM blocks');
        dbBlockCount = parseInt(countRes.rows[0].count);
    } catch(e) {}

    // MAIN POSTGRESQL LOAD
    if (dbBlockCount > 0) {
        try {
            const blockRes = await pool.query('SELECT * FROM blocks ORDER BY index ASC');
            const txRes = await pool.query('SELECT * FROM transactions ORDER BY timestamp_ms ASC, id ASC');
            
            const txsByBlock = {};
            txRes.rows.forEach(tx => {
                if (!txsByBlock[tx.block_index]) txsByBlock[tx.block_index] = [];
                const parsedTx = {
                    from: tx.from_address, to: tx.to_address, amount: parseFloat(tx.amount),
                    type: tx.type, tokenSymbol: tx.token_symbol, timestamp: parseInt(tx.timestamp_ms)
                };
                if (tx.amount_usd) parsedTx.amountUsd = parseFloat(tx.amount_usd);
                if (tx.is_system_generated) parsedTx.isSystemGenerated = true;
                if (tx.signature) parsedTx.signature = tx.signature;
                if (tx.public_key) parsedTx.publicKey = tx.public_key;
                if (tx.platform_type) parsedTx.platformType = tx.platform_type;
                if (tx.description) parsedTx.description = tx.description;
                txsByBlock[tx.block_index].push(parsedTx);
            });

            this.chain = blockRes.rows.map(b => {
                const block = new Block(b.index, parseInt(b.timestamp_ms), txsByBlock[b.index] || [], b.previous_hash);
                block.nonce = b.nonce; block.hash = b.hash;
                return block;
            });
            
            await this.state.loadSnapshot(this.chain);
            this.rebuildPriceHistory();
            this.recalculateDifficulty();
            console.log(chalk.green(`[DATACHAIN] Successfully loaded ${this.chain.length} blocks from PostgreSQL.`));
            
            await this.executeHardForkAmnesty();
            return;
        } catch(e) {
            console.warn(chalk.yellow("[DATACHAIN] PostgreSQL load error. Checking JSON fallback..."));
        }
    }

    // JSON FALLBACK LOAD
    if (fs.existsSync(this.chainFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(this.chainFile, 'utf8'));
            this.chain = data.map(b => {
                const block = new Block(b.index, b.timestamp, b.data, b.previousHash);
                block.nonce = b.nonce; block.hash = b.hash;
                return block;
            });
            
            await this.state.loadSnapshot(this.chain);
            this.rebuildPriceHistory();
            this.recalculateDifficulty();
            console.log(chalk.green(`[DATACHAIN] Successfully loaded ${this.chain.length} blocks from JSON.`));
            
            await this.syncAllToDB(); 
            await this.executeHardForkAmnesty();
            return;
        } catch(e) {}
    }

    // GENESIS LOAD
    console.warn(chalk.yellow("[DATACHAIN] Starting fresh chain from genesis."));
    this.chain = [this.createGenesisBlock()];
    await this.state.loadSnapshot(this.chain);
    this.rebuildPriceHistory();
    this.difficulty = 2;
    
    await this.executeHardForkAmnesty();
  }

  async syncAllToDB() {
      const check = await pool.query('SELECT COUNT(*) FROM blocks').catch(() => ({rows:[{count:0}]}));
      if (parseInt(check.rows[0].count) > 0) return; 

      const client = await pool.connect();
      try {
          await client.query('BEGIN');
          for (const block of this.chain) {
              await client.query(
                  'INSERT INTO blocks (index, timestamp_ms, previous_hash, hash, nonce) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (index) DO NOTHING',
                  [block.index, block.timestamp, block.previousHash, block.hash, block.nonce]
              );
              if (typeof block.data !== 'string') {
                  for (const tx of block.data) {
                      await client.query(
                          `INSERT INTO transactions (block_index, from_address, to_address, amount, amount_usd, type, token_symbol, timestamp_ms, is_system_generated, signature, public_key, platform_type, description) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                          [block.index, tx.from, tx.to, tx.amount, tx.amountUsd || 0, tx.type, tx.tokenSymbol || 'SYR', tx.timestamp, !!tx.isSystemGenerated, tx.signature || '', tx.publicKey || '', tx.platformType || '', tx.description || '']
                      );
                  }
              }
          }
          await client.query('COMMIT');
          console.log(chalk.green("[DATACHAIN] Successfully migrated local JSON chain to PostgreSQL!"));
          await this.state.saveSnapshot(this.chain.length - 1);
      } catch(e) {
          await client.query('ROLLBACK');
          console.error(chalk.red("[DATACHAIN] DB Migration failed"), e);
      } finally {
          client.release();
      }
  }

  async saveChain() {
      if (this.isSaving) {
          this.saveQueue = true;
          return;
      }
      this.isSaving = true;
      this.saveQueue = false;

      try {
          if (!fs.existsSync(this.volumeDir)) fs.mkdirSync(this.volumeDir, { recursive: true });
          const tempFile = this.chainFile + '.tmp';
          await fs.promises.writeFile(tempFile, JSON.stringify(this.chain));
          await fs.promises.rename(tempFile, this.chainFile);
          await fs.promises.copyFile(this.chainFile, this.backupFile);
      } catch (e) {
          console.error(chalk.red("[DATACHAIN] Error saving JSON fallback"));
      }

      const client = await pool.connect();
      try {
          await client.query('BEGIN');
          const latestBlock = this.getLatestBlock();
          
          await client.query(
              'INSERT INTO blocks (index, timestamp_ms, previous_hash, hash, nonce) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (index) DO NOTHING',
              [latestBlock.index, latestBlock.timestamp, latestBlock.previousHash, latestBlock.hash, latestBlock.nonce]
          );

          if (typeof latestBlock.data !== 'string') {
              const txCheck = await client.query('SELECT COUNT(*) FROM transactions WHERE block_index = $1', [latestBlock.index]);
              if (parseInt(txCheck.rows[0].count) === 0) {
                  for (const tx of latestBlock.data) {
                      await client.query(
                          `INSERT INTO transactions (block_index, from_address, to_address, amount, amount_usd, type, token_symbol, timestamp_ms, is_system_generated, signature, public_key, platform_type, description) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                          [latestBlock.index, tx.from, tx.to, tx.amount, tx.amountUsd || 0, tx.type, tx.tokenSymbol || 'SYR', tx.timestamp, !!tx.isSystemGenerated, tx.signature || '', tx.publicKey || '', tx.platformType || '', tx.description || '']
                      );
                  }
              }
          }
          await client.query('COMMIT');
      } catch (e) {
          await client.query('ROLLBACK');
          console.error(chalk.red("[DATACHAIN] DB Save Error:"), e);
      } finally {
          client.release();
          this.isSaving = false;
          if (this.saveQueue) this.saveChain();
      }
  }

  createGenesisBlock() {
    return new Block(0, new Date(config.blockchain.genesis_date).getTime(), "Scientific Nexus Genesis Block", "0");
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  // =========================================================================
  // HARD FORK AIRDROP PROTOCOL
  // =========================================================================
  async executeHardForkAmnesty() {
      let totalCirculating = 0;
      const syrBalances = this.state.balances["SYR"] || {};
      for (const address in syrBalances) {
          if (address !== "system" && syrBalances[address] > 0) {
              totalCirculating += syrBalances[address];
          }
      }
      
      // If circulating supply is under 5.98 Billion, the legacy history was destroyed by Railway.
      // We will explicitly recreate it right here with your precise addresses.
      if (totalCirculating < 5980000000) {
          console.log(chalk.magenta.bold("[HARD FORK] Legacy history missing. Executing 5.98 Billion Genesis Airdrop..."));
          
          const walletWith3Billion = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5z7IyY";
          const walletWith2Billion980M = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcZsKwt";
          
          const rescueTxs = [];
          
          rescueTxs.push({ 
              from: "system", 
              to: walletWith3Billion, 
              amount: 3000000000, 
              type: "MINT", 
              tokenSymbol: "SYR", 
              timestamp: Date.now(), 
              isSystemGenerated: true,
              description: "Nexus Genesis Airdrop Recovery"
          });
          
          rescueTxs.push({ 
              from: "system", 
              to: walletWith2Billion980M, 
              amount: 2980000000, 
              type: "MINT", 
              tokenSymbol: "SYR", 
              timestamp: Date.now() + 1000, 
              isSystemGenerated: true,
              description: "Nexus Genesis Airdrop Recovery"
          });

          if (rescueTxs.length > 0) {
              const newBlock = new Block(this.chain.length, Date.now(), rescueTxs, this.getLatestBlock().hash);
              await newBlock.mineBlock(this.difficulty);
              
              for (const tx of rescueTxs) {
                  this.state.applyTransaction(tx, this.getLastMarketPrice(0.50), false);
              }
              
              this.chain.push(newBlock);
              await this.saveChain();
              await this.state.saveSnapshot(this.chain.length - 1);
              console.log(chalk.green.bold("[HARD FORK] 5.98 Billion SilverCash Successfully Injected."));
          }
      }
  }
  // =========================================================================

  getRemainingSupply(tokenSymbol = "SYR") {
    if (tokenSymbol !== "SYR") return 0;
    
    let totalCirculating = 0;
    const syrBalances = this.state.balances["SYR"] || {};
    
    for (const address in syrBalances) {
        if (address !== "system") {
            if (syrBalances[address] > 0) {
                totalCirculating += syrBalances[address];
            }
        }
    }
    
    return Math.max(0, 6000000000 - totalCirculating);
  }

  getLastMarketPrice(defaultPrice) {
      for (let i = this.chain.length - 1; i >= 0; i--) {
          const block = this.chain[i];
          if (typeof block.data === 'string') continue;
          for (let j = block.data.length - 1; j >= 0; j--) {
              const tx = block.data[j];
              if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) {
                  return tx.amountUsd / tx.amount;
              }
              if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.priceUsd) {
                  return tx.priceUsd;
              }
          }
      }
      return defaultPrice;
  }

  rebuildPriceHistory() {
      const history = [];
      history.push({ timestamp: new Date(config.blockchain.genesis_date).getTime(), price: config.blockchain.starting_price });
      for (const block of this.chain) {
          if (typeof block.data === 'string') continue;
          for (const tx of block.data) {
              if ((tx.tokenSymbol === 'SYR' || !tx.tokenSymbol)) {
                  if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) history.push({ timestamp: tx.timestamp, price: tx.amountUsd / tx.amount });
                  else if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.priceUsd) history.push({ timestamp: tx.timestamp, price: tx.priceUsd });
              }
          }
      }
      const unique = new Map();
      history.forEach(d => unique.set(Math.floor(d.timestamp / 1000), d.price));
      this.priceHistoryCache = Array.from(unique.entries())
          .map(([t, p]) => ({ timestamp: t * 1000, price: p }))
          .sort((a, b) => a.timestamp - b.timestamp);
  }

  appendPriceHistory(block) {
      if (typeof block.data === 'string') return;
      let added = false;
      for (const tx of block.data) {
          if ((tx.tokenSymbol === 'SYR' || !tx.tokenSymbol)) {
              if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) {
                  this.priceHistoryCache.push({ timestamp: tx.timestamp, price: tx.amountUsd / tx.amount });
                  added = true;
              } else if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.priceUsd) {
                  this.priceHistoryCache.push({ timestamp: tx.timestamp, price: tx.priceUsd });
                  added = true;
              }
          }
      }
      if (added) {
          const unique = new Map();
          this.priceHistoryCache.forEach(d => unique.set(Math.floor(d.timestamp / 1000), d.price));
          this.priceHistoryCache = Array.from(unique.entries())
              .map(([t, p]) => ({ timestamp: t * 1000, price: p }))
              .sort((a, b) => a.timestamp - b.timestamp);
      }
  }

  async addBlock(transactions, currentPrice = 0) {
    if (this.isInitializing) {
        await this.isInitializing;
        this.isInitializing = null;
    }

    if (!transactions || transactions.length === 0) return false;

    if (transactions.length === 1 && transactions[0].type === "MINT" && transactions[0].amount === 6000000000) {
        if (this.chain.length > 0 && this.chain[0].index === 0) return true;
    }

    let rewardAmount = config.blockchain.reward;
    if (config.blockchain.halving_interval) {
        const halvings = Math.floor(this.chain.length / config.blockchain.halving_interval);
        rewardAmount = rewardAmount / Math.pow(2, halvings);
    }
    const remaining = this.getRemainingSupply("SYR");
    if (rewardAmount > remaining) rewardAmount = remaining;

    const rewardTx = {
        from: "system",
        to: config.blockchain.miner_address,
        amount: rewardAmount,
        type: "TRANSFER",
        tokenSymbol: "SYR", 
        timestamp: Date.now(),
        isSystemGenerated: true
    };

    const tempState = new State();
    tempState.balances = JSON.parse(JSON.stringify(this.state.balances));
    tempState.usd_balances = { ...this.state.usd_balances }; 
    
    const validTransactions = rewardAmount > 0 ? [rewardTx] : [];
    if (rewardAmount > 0) tempState.applyTransaction(rewardTx, currentPrice, false);

    for (const tx of transactions) {
      if (tempState.applyTransaction(tx, currentPrice, false)) {
        validTransactions.push(tx);
      } else {
        console.log(chalk.red(`[VALIDATION] Tx dropped due to insufficient funds/conflict: ${tx.from} -> ${tx.to}`));
      }
    }

    const newBlock = new Block(this.chain.length, Date.now(), validTransactions, this.getLatestBlock().hash);
    
    await newBlock.mineBlock(this.difficulty); 

    if (!validator.validateBlock(newBlock, this.getLatestBlock())) return false;

    this.chain.push(newBlock);
    this.state = tempState;
    
    this.adjustDifficulty();
    this.appendPriceHistory(newBlock); 
    await this.saveChain(); 
    await this.state.saveSnapshot(this.chain.length - 1); 
    
    return true;
  }

  getBalance(address, tokenSymbol = "SYR") { 
      return this.state.getBalance(address, tokenSymbol); 
  }

  recalculateDifficulty() {
    const TARGET_TIME = 10000;
    const ADJUSTMENT_INTERVAL = 10;
    this.difficulty = 2;
    for (let i = ADJUSTMENT_INTERVAL; i < this.chain.length; i += ADJUSTMENT_INTERVAL) {
        const prev = this.chain[i - ADJUSTMENT_INTERVAL];
        const curr = this.chain[i];
        const timeTaken = curr.timestamp - prev.timestamp;
        const timeExpected = TARGET_TIME * ADJUSTMENT_INTERVAL;
        if (timeTaken < timeExpected / 2) this.difficulty++;
        else if (timeTaken > timeExpected * 2 && this.difficulty > 2) this.difficulty--;
    }
  }

  adjustDifficulty() {
    const TARGET_TIME = 10000; 
    const ADJUSTMENT_INTERVAL = 10;

    if (this.chain.length > 0 && this.chain.length % ADJUSTMENT_INTERVAL === 0) {
      const prevAdjustmentBlock = this.chain[this.chain.length - ADJUSTMENT_INTERVAL];
      const timeExpected = TARGET_TIME * ADJUSTMENT_INTERVAL;
      const timeTaken = this.getLatestBlock().timestamp - prevAdjustmentBlock.timestamp;

      if (timeTaken < timeExpected / 2) {
        this.difficulty++;
      } else if (timeTaken > timeExpected * 2 && this.difficulty > 2) {
        this.difficulty--;
      }
      console.log(chalk.yellow(`[NETWORK] Difficulty adjusted to: ${this.difficulty}`));
    }
  }
}

export { DataChain };