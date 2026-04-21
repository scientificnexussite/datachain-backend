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

    // Store the Promise so the startup IIFE and addBlock() can await it
    this.isInitializing = this.loadChain();
  }

  async loadChain() {
    // ── Step 1: Find the best (longest) chain from all local JSON sources ──────
    const legacyChain  = path.join(process.cwd(), 'chain.json');
    const legacyBackup = path.join(process.cwd(), 'chain_backup.json');

    let bestChainData = null;
    let bestLen = 0;

    const filesToCheck = [legacyChain, legacyBackup, this.chainFile, this.backupFile];
    for (const file of filesToCheck) {
        if (fs.existsSync(file)) {
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (Array.isArray(data) && data.length > bestLen) {
                    bestLen = data.length;
                    bestChainData = data;
                }
            } catch(e) {
                console.warn(chalk.yellow(`[DATACHAIN] Could not parse ${file}: ${e.message}`));
            }
        }
    }

    // Persist the best JSON to the volume for safety
    if (bestChainData && bestLen > 0) {
        try {
            if (!fs.existsSync(this.volumeDir)) fs.mkdirSync(this.volumeDir, { recursive: true });
            fs.writeFileSync(this.chainFile, JSON.stringify(bestChainData));
            fs.writeFileSync(this.backupFile,  JSON.stringify(bestChainData));
        } catch(e) {
            console.warn(chalk.yellow("[DATACHAIN] Could not persist JSON backup: " + e.message));
        }
    }

    // ── Step 2: Check database state ─────────────────────────────────────────
    let dbBlockCount = 0;
    try {
        const countRes = await pool.query('SELECT COUNT(*) FROM blocks');
        dbBlockCount = parseInt(countRes.rows[0].count);
    } catch(e) {
        console.warn(chalk.yellow("[DATACHAIN] Could not query DB block count: " + e.message));
    }

    // ── Step 3: Integrity check – force DB wipe if it is out of sync ──────────
    //
    // BUG FIX 1 (was BUG 1 + BUG 2):
    // The old code only checked for the presence of a massive tx (>2B), which
    // meant a PARTIAL prior migration (some blocks written before a crash) would
    // satisfy the check and prevent a needed TRUNCATE.
    //
    // NEW RULE: The DB must contain EXACTLY the same number of blocks as the best
    // JSON. Any mismatch — fewer OR more — means the DB is stale and must be wiped
    // so that a fresh, complete migration can run.
    //
    if (dbBlockCount > 0 && bestLen > 0 && dbBlockCount !== bestLen) {
        console.log(chalk.red.bold(
            `[CRITICAL] DB block count (${dbBlockCount}) does not match JSON block count (${bestLen}). ` +
            `Wiping DB to force a clean, complete migration...`
        ));
        try {
            await pool.query(
                'TRUNCATE blocks, transactions, state_meta, state_usd_balances, state_balances, menubook_store, api_state CASCADE'
            );
        } catch(e) {
            // Some tables may not exist yet; truncate what we can
            try { await pool.query('TRUNCATE blocks, transactions CASCADE'); } catch(_) {}
            try { await pool.query('TRUNCATE state_meta, state_usd_balances, state_balances CASCADE'); } catch(_) {}
        }
        dbBlockCount = 0;
    }

    // ── Step 4a: Load from PostgreSQL (primary path once migration is done) ───
    if (dbBlockCount > 0) {
        try {
            const blockRes = await pool.query('SELECT * FROM blocks ORDER BY index ASC');
            const txRes    = await pool.query('SELECT * FROM transactions ORDER BY block_index ASC, id ASC');

            const txsByBlock = {};
            txRes.rows.forEach(tx => {
                if (!txsByBlock[tx.block_index]) txsByBlock[tx.block_index] = [];
                const parsedTx = {
                    from: tx.from_address,
                    to:   tx.to_address,
                    // BUG FIX 4: Always parse amount as float to guard against stored strings
                    amount:      parseFloat(tx.amount),
                    type:        tx.type,
                    tokenSymbol: tx.token_symbol,
                    timestamp:   parseInt(tx.timestamp_ms)
                };
                // BUG FIX 4: amount_usd was stored as NULL for legacy BUY; only set when truly present
                if (tx.amount_usd !== null && tx.amount_usd !== undefined && tx.amount_usd !== 0) {
                    parsedTx.amountUsd = parseFloat(tx.amount_usd);
                }
                if (tx.is_system_generated) parsedTx.isSystemGenerated = true;
                if (tx.signature)    parsedTx.signature    = tx.signature;
                if (tx.public_key)   parsedTx.publicKey    = tx.public_key;
                if (tx.platform_type) parsedTx.platformType = tx.platform_type;
                if (tx.description)  parsedTx.description  = tx.description;
                txsByBlock[tx.block_index].push(parsedTx);
            });

            this.chain = blockRes.rows.map(b => {
                const block = new Block(b.index, parseInt(b.timestamp_ms), txsByBlock[b.index] || [], b.previous_hash);
                block.nonce = b.nonce;
                block.hash  = b.hash;
                return block;
            });

            await this.state.loadSnapshot(this.chain);
            this.rebuildPriceHistory();
            this.recalculateDifficulty();
            console.log(chalk.green(`[DATACHAIN] Successfully loaded ${this.chain.length} blocks from PostgreSQL.`));
            return;
        } catch(e) {
            console.warn(chalk.yellow("[DATACHAIN] PostgreSQL load error. Falling back to JSON... " + e.message));
        }
    }

    // ── Step 4b: Load from JSON and migrate to DB (first-time or recovery path) ─
    if (bestChainData && bestLen > 0) {
        this.chain = bestChainData.map(b => {
            const block = new Block(b.index, b.timestamp, b.data, b.previousHash);
            block.nonce = b.nonce;
            block.hash  = b.hash;
            return block;
        });

        await this.state.loadSnapshot(this.chain);
        this.rebuildPriceHistory();
        this.recalculateDifficulty();

        console.log(chalk.green(`[DATACHAIN] Successfully loaded ${this.chain.length} blocks from JSON.`));

        // BUG FIX 1: syncAllToDB MUST be awaited so the migration completes fully
        // before the process is considered ready. A fire-and-forget here means the
        // next Railway restart can find a partially-written DB and load wrong state.
        console.log(chalk.blue("[DATACHAIN] Starting full JSON → PostgreSQL migration (awaited)..."));
        await this.syncAllToDB();
        return;
    }

    // ── Step 4c: Truly fresh chain ────────────────────────────────────────────
    console.warn(chalk.yellow("[DATACHAIN] No chain data found. Starting fresh from genesis."));
    this.chain = [this.createGenesisBlock()];
    await this.state.loadSnapshot(this.chain);
    this.rebuildPriceHistory();
    this.difficulty = 2;
  }

  async syncAllToDB() {
      // Guard: do not re-run if DB already has all the blocks we intend to write
      let currentDbCount = 0;
      try {
          const check = await pool.query('SELECT COUNT(*) FROM blocks');
          currentDbCount = parseInt(check.rows[0].count);
      } catch(e) {
          console.warn(chalk.yellow("[DATACHAIN] syncAllToDB: Could not check DB count: " + e.message));
      }

      if (currentDbCount === this.chain.length) {
          console.log(chalk.green("[DATACHAIN] DB already up to date. Skipping migration."));
          return;
      }

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
                      // BUG FIX 4: Store NULL (not 0) for amount_usd when it is genuinely absent.
                      // A stored 0 is falsy in JS and will be silently dropped on load, breaking
                      // the amountUsd field for every legacy BUY transaction.
                      const amountUsd = (tx.amountUsd !== undefined && tx.amountUsd !== null)
                          ? tx.amountUsd
                          : null;

                      await client.query(
                          `INSERT INTO transactions
                              (block_index, from_address, to_address, amount, amount_usd, type, token_symbol,
                               timestamp_ms, is_system_generated, signature, public_key, platform_type, description)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                           ON CONFLICT DO NOTHING`,
                          [
                              block.index,
                              tx.from,
                              tx.to,
                              tx.amount,
                              amountUsd,
                              tx.type,
                              tx.tokenSymbol || 'SYR',
                              tx.timestamp,
                              !!tx.isSystemGenerated,
                              tx.signature    || null,
                              tx.publicKey    || null,
                              tx.platformType || null,
                              tx.description  || null
                          ]
                      );
                  }
              }
          }

          await client.query('COMMIT');
          console.log(chalk.green("[DATACHAIN] Successfully migrated full JSON chain to PostgreSQL!"));

          // Persist the final correct state so next boot can use the fast snapshot path
          await this.state.saveSnapshot(this.chain.length - 1);

      } catch(e) {
          await client.query('ROLLBACK');
          console.error(chalk.red("[DATACHAIN] DB Migration failed:"), e);
          throw e; // Re-throw so the caller knows migration failed
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
          const tempFile = this.chainFile + '.tmp';
          await fs.promises.writeFile(tempFile, JSON.stringify(this.chain));
          await fs.promises.rename(tempFile, this.chainFile);
          // Always keep the backup in sync with the main file
          await fs.promises.copyFile(this.chainFile, this.backupFile);
      } catch (e) {
          console.error(chalk.red("[DATACHAIN] Error saving JSON fallback: " + e.message));
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
              const txCheck = await client.query(
                  'SELECT COUNT(*) FROM transactions WHERE block_index = $1',
                  [latestBlock.index]
              );
              if (parseInt(txCheck.rows[0].count) === 0) {
                  for (const tx of latestBlock.data) {
                      const amountUsd = (tx.amountUsd !== undefined && tx.amountUsd !== null)
                          ? tx.amountUsd
                          : null;

                      await client.query(
                          `INSERT INTO transactions
                              (block_index, from_address, to_address, amount, amount_usd, type, token_symbol,
                               timestamp_ms, is_system_generated, signature, public_key, platform_type, description)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                          [
                              latestBlock.index,
                              tx.from,
                              tx.to,
                              tx.amount,
                              amountUsd,
                              tx.type,
                              tx.tokenSymbol || 'SYR',
                              tx.timestamp,
                              !!tx.isSystemGenerated,
                              tx.signature    || null,
                              tx.publicKey    || null,
                              tx.platformType || null,
                              tx.description  || null
                          ]
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

  getRemainingSupply(tokenSymbol = "SYR") {
    if (tokenSymbol !== "SYR") return 0;

    let totalCirculating = 0;
    const syrBalances = this.state.balances["SYR"] || {};

    for (const address in syrBalances) {
        if (address !== "system" && syrBalances[address] > 0) {
            totalCirculating += syrBalances[address];
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
                  if (tx.type === 'MARKET_TRADE' && tx.amountUsd && tx.amount) {
                      history.push({ timestamp: tx.timestamp, price: tx.amountUsd / tx.amount });
                  } else if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.priceUsd) {
                      history.push({ timestamp: tx.timestamp, price: tx.priceUsd });
                  }
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
    // Guarantee loadChain has fully completed before any block is added
    if (this.isInitializing) {
        await this.isInitializing;
        this.isInitializing = null;
    }

    if (!transactions || transactions.length === 0) return false;

    // Guard against accidentally re-minting the genesis supply on restart
    if (
        transactions.length === 1 &&
        transactions[0].type === "MINT" &&
        parseFloat(transactions[0].amount) === 6000000000 &&
        this.chain.length > 1
    ) {
        console.warn(chalk.yellow("[DATACHAIN] Blocked duplicate genesis MINT — chain already initialized."));
        return true; // Return true so the caller doesn't retry
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
    tempState.balances     = JSON.parse(JSON.stringify(this.state.balances));
    tempState.usd_balances = { ...this.state.usd_balances };

    const validTransactions = rewardAmount > 0 ? [rewardTx] : [];
    if (rewardAmount > 0) tempState.applyTransaction(rewardTx, currentPrice);

    for (const tx of transactions) {
      if (tempState.applyTransaction(tx, currentPrice)) {
        validTransactions.push(tx);
      } else {
        console.log(chalk.red(`[VALIDATION] Tx dropped: ${tx.from} -> ${tx.to} (${tx.type} ${tx.amount})`));
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
