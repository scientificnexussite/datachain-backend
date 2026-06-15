import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import pool from './db.js'; // Issue #3 Fixed

const fixDust = (num) => Number(Number(num).toFixed(8));

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
    CREATE TABLE IF NOT EXISTS state_liquidity_pools (
        token_symbol  VARCHAR(20) PRIMARY KEY,
        token_reserve DOUBLE PRECISION DEFAULT 0,
        usd_reserve   DOUBLE PRECISION DEFAULT 0,
        virtual_token_reserve DOUBLE PRECISION DEFAULT 0,
        virtual_usd_reserve   DOUBLE PRECISION DEFAULT 0
    );
`).catch(err => console.error(chalk.red("[DB] Failed to initialize state tables"), err));

class State {
  constructor() {
    this.balances = { "SYR": {} };     
    this.usd_balances = {};

    // Task B — Liquidity pool reserves for each non-SYR custom token.
    // Keyed by ticker (UPPERCASE); value: { tokenReserve, usdReserve }.
    // poolPrice = usdReserve / tokenReserve when both > 0.
    this.liquidityPools = {};
    
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

  // ── Liquidity Pool Helpers ─────────────────────────────────────────────────
  // Task B — Initialise or retrieve a token's liquidity pool entry.
  initPool(tokenSymbol) {
    const t = tokenSymbol.toUpperCase();
    if (!this.liquidityPools[t]) {
      this.liquidityPools[t] = { tokenReserve: 0, usdReserve: 0, virtualTokenReserve: 0, virtualUsdReserve: 0 };
    }
    // Ensure virtual fields exist on legacy pools loaded from snapshot
    const lp = this.liquidityPools[t];
    if (lp.virtualTokenReserve === undefined) lp.virtualTokenReserve = 0;
    if (lp.virtualUsdReserve   === undefined) lp.virtualUsdReserve   = 0;
    return lp;
  }

  // Task B — Current pool spot price for a token (0 if pool inactive).
  // Uses effective reserves (real + virtual) for price calculation.
  getPoolPrice(tokenSymbol) {
    const p = this.liquidityPools[tokenSymbol];
    if (!p) return 0;
    const effToken = p.tokenReserve + (p.virtualTokenReserve || 0);
    const effUsd   = p.usdReserve   + (p.virtualUsdReserve   || 0);
    if (effToken <= 0 || effUsd <= 0) return 0;
    return fixDust(effUsd / effToken);
  }

    applyTransaction(tx, currentPrice = 0, isReplay = false) {
    let { from, to, type } = tx;

    // --- ARMOR PLATE 6: THE LEDGER LOCK (Immutable Math Bounds) ---
    // The absolute final barrier before writing to the database.
    // Blocks negative numbers, zero, AND massive overflow attacks.
    let amount = parseFloat(tx.amount);
    let amountUsdCheck = parseFloat(tx.amountUsd || 0);

    if (isNaN(amount) || amount <= 0 || amount > 100000000000) {
        if (!isReplay) console.log(chalk.red(`[LEDGER SECURITY] Rejected: Invalid or overflow token amount.`));
        return false;
    }
    if (isNaN(amountUsdCheck) || amountUsdCheck < 0 || amountUsdCheck > 100000000000) {
        if (!isReplay) console.log(chalk.red(`[LEDGER SECURITY] Rejected: Invalid or overflow USD amount.`));
        return false;
    }

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

    // Task B — LIQUIDITY_INIT: system-generated tx that bootstraps the pool
    // with virtual reserves so the system has inventory to market-make from.
    // amount = token reserve seeded; tx.amountUsd = virtual USD counterpart.
    // No tokens are taken from the deployer — these are virtual system reserves.
    if (type === 'LIQUIDITY_INIT') {
      const lp = this.initPool(tokenSymbol);
      lp.tokenReserve = fixDust(amount);
      lp.usdReserve   = fixDust(parseFloat(tx.amountUsd) || 0);

      // AMM Upgrade: Initialize virtual reserves for $10K depth cushion.
      // This makes the bonding curve dramatically flatter at launch.
      const seedPrice = lp.usdReserve > 0 && lp.tokenReserve > 0
          ? lp.usdReserve / lp.tokenReserve
          : 0.01;
      const VIRTUAL_USD = 10_000;
      lp.virtualUsdReserve   = VIRTUAL_USD;
      lp.virtualTokenReserve = fixDust(VIRTUAL_USD / seedPrice);

      // Credit the system address so it has tokens to fill market-make orders
      this.balances[tokenSymbol]['system'] = fixDust(
        (this.balances[tokenSymbol]['system'] || 0) + amount
      );
      return true;
    }

    // Task B — LIQUIDITY_DEPOSIT: deployer voluntarily sends tokens to pool.
    // tokenReserve increases; usdReserve unchanged (price drops, more depth).
    // User's balance decreases; 'liquidity-pool' address is the accounting sink.
    if (type === 'LIQUIDITY_DEPOSIT') {
      const userBal = this.balances[tokenSymbol][from] || 0;
      if (!isReplay && userBal < amount) return false;
      this.balances[tokenSymbol][from] = fixDust(userBal - amount);
      this.balances[tokenSymbol]['liquidity-pool'] = fixDust(
        (this.balances[tokenSymbol]['liquidity-pool'] || 0) + amount
      );
      const lp = this.initPool(tokenSymbol);
      lp.tokenReserve = fixDust(lp.tokenReserve + amount);
      return true;
    }

    // Task B — LIQUIDITY_WITHDRAW: user pays USD to retrieve tokens from pool.
    // tx.priceUsd = current pool price used for this withdrawal.
    // usdReserve increases; tokenReserve decreases; user's USD is deducted.
    if (type === 'LIQUIDITY_WITHDRAW') {
      const withdrawPrice = parseFloat(tx.priceUsd) || 0;
      const usdCost = fixDust(amount * withdrawPrice);
      const lp = this.initPool(tokenSymbol);
      if (!isReplay) {
        if (lp.tokenReserve < amount) return false;
        if (!this.deductUsd(from, usdCost)) return false;
      }
      lp.tokenReserve = fixDust(lp.tokenReserve - amount);
      lp.usdReserve   = fixDust(lp.usdReserve + usdCost);
      const poolBal = this.balances[tokenSymbol]['liquidity-pool'] || 0;
      this.balances[tokenSymbol]['liquidity-pool'] = fixDust(poolBal - amount);
      this.balances[tokenSymbol][from] = fixDust((this.balances[tokenSymbol][from] || 0) + amount);
      return true;
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

    // Task 3 FIX — Only allow the system to auto-mint tokens for SYR (its own
    // supply). For custom tokens, the system must use only its real balance
    // (credited by LIQUIDITY_INIT or LIQUIDITY_DEPOSIT). Auto-minting custom
    // tokens out of thin air would bypass the economic model and allow unlimited
    // token creation, undermining the liquidity pool design.
    if (sender === 'system' && senderBalance < amount && tokenSymbol === 'SYR') {
        // SYR: system is the mint authority and can create new supply as needed
        this.balances[tokenSymbol][sender] = fixDust(senderBalance + amount);
        senderBalance = this.balances[tokenSymbol][sender];
    }

    if (type === 'TRANSFER' || type === 'MARKET_TRADE' || type === 'BUY' || type === 'SELL') {
        // For custom tokens: system is bound by its actual balance just like any user.
        // For SYR: system already had its balance topped up above if needed.
        if (!isReplay && senderBalance < amount && (sender !== 'system' || tokenSymbol !== 'SYR')) return false; 
        
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

        // Task B — Load persisted liquidity pool reserves from DB.
        try {
            const lpRes = await pool.query('SELECT token_symbol, token_reserve, usd_reserve, COALESCE(virtual_token_reserve, 0) as virtual_token_reserve, COALESCE(virtual_usd_reserve, 0) as virtual_usd_reserve FROM state_liquidity_pools');
            for (const row of lpRes.rows) {
                this.liquidityPools[row.token_symbol] = {
                    tokenReserve:        parseFloat(row.token_reserve) || 0,
                    usdReserve:          parseFloat(row.usd_reserve)   || 0,
                    virtualTokenReserve: parseFloat(row.virtual_token_reserve) || 0,
                    virtualUsdReserve:   parseFloat(row.virtual_usd_reserve)   || 0
                };
            }
            if (Object.keys(this.liquidityPools).length > 0) {
                console.log(chalk.cyan(`[STATE] Loaded ${Object.keys(this.liquidityPools).length} liquidity pool(s).`));
            }
        } catch (lpErr) {
            console.warn(chalk.yellow('[STATE] Could not load liquidity pools (table may not exist yet):'), lpErr.message);
        }
        
        if (Object.keys(this.usd_balances).length === 0 && Object.keys(this.balances["SYR"] || {}).length === 0) {
            throw new Error("Empty Postgres State");
        }
        console.log(chalk.green(`[STATE] PostgreSQL Snapshot loaded successfully.`));
    } catch (e) {
        console.log(chalk.yellow("[STATE] Database state empty or missing. Rebuilding ledger mathematically from DB Transactions..."));
        this.balances = { "SYR": {} };
        this.usd_balances = {};
        this.liquidityPools = {};

        try {
            const allTxs = await pool.query("SELECT * FROM transactions ORDER BY block_index ASC, timestamp_ms ASC, id ASC");
            for (const row of allTxs.rows) {
                const tx = {
                    from: row.from_address, to: row.to_address, amount: parseFloat(row.amount),
                    amountUsd: parseFloat(row.amount_usd), type: row.type, tokenSymbol: row.token_symbol,
                    priceUsd: parseFloat(row.price_usd)
                };
                this.applyTransaction(tx, 0, true); 
            }
        } catch(dbErr) {
             console.log(chalk.red("[STATE] DB Replay failed. Attempting memory object fallback..."));
             for (let i = 0; i < chain.length; i++) {
                const block = chain[i];
                if (typeof block.data === 'string') continue;
                for (const tx of block.data) this.applyTransaction(tx, 0, true); 
             }
        }
        
        console.log(chalk.green(`[STATE] Mathematical replay complete.`));
    }
  }

  // Issue #4 Fixed: High Performance Bulk Upsert prevents DB locks
  // Limitation 5 FIX: Added zero-balance row pruning after every successful save.
  // This prevents the state_balances and state_usd_balances tables from accumulating
  // stale rows for accounts that have spent all their tokens, which degrades performance
  // as the chain grows.
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
          const snapshot = {
              balances: this.balances,
              usd_balances: this.usd_balances,
              liquidityPools: this.liquidityPools,
              lastIndex
          };
          const tempFile = this.snapshotFile + '.tmp';
          await fs.promises.writeFile(tempFile, JSON.stringify(snapshot));
          await fs.promises.rename(tempFile, this.snapshotFile);
      } catch (e) {}

      const client = await pool.connect();
      try {
          await client.query('BEGIN');
          
          await client.query('INSERT INTO state_meta (id, last_index) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET last_index = $1', [lastIndex]);
          
          const usdAddresses = Object.keys(this.usd_balances);
          const usdBalances = Object.values(this.usd_balances);
          
          if (usdAddresses.length > 0) {
              await client.query(
                  `INSERT INTO state_usd_balances (address, balance)
                   SELECT * FROM UNNEST($1::varchar[], $2::float8[])
                   ON CONFLICT (address) DO UPDATE SET balance = EXCLUDED.balance`,
                  [usdAddresses, usdBalances]
              );
          }

          const balAddresses = [];
          const balTokens = [];
          const balAmounts = [];
          
          for (const tokenSymbol in this.balances) {
              for (const address in this.balances[tokenSymbol]) {
                  balAddresses.push(address);
                  balTokens.push(tokenSymbol);
                  balAmounts.push(this.balances[tokenSymbol][address]);
              }
          }

          if (balAddresses.length > 0) {
              await client.query(
                  `INSERT INTO state_balances (address, token_symbol, balance)
                   SELECT * FROM UNNEST($1::varchar[], $2::varchar[], $3::float8[])
                   ON CONFLICT (address, token_symbol) DO UPDATE SET balance = EXCLUDED.balance`,
                  [balAddresses, balTokens, balAmounts]
              );
          }

          // Task B — Persist liquidity pool reserves alongside balances.
          const lpTickers       = Object.keys(this.liquidityPools);
          const lpTokenReserves = lpTickers.map(t => this.liquidityPools[t].tokenReserve);
          const lpUsdReserves   = lpTickers.map(t => this.liquidityPools[t].usdReserve);
          const lpVirtualTokens = lpTickers.map(t => this.liquidityPools[t].virtualTokenReserve || 0);
          const lpVirtualUsd    = lpTickers.map(t => this.liquidityPools[t].virtualUsdReserve || 0);

          if (lpTickers.length > 0) {
              // Ensure virtual reserve columns exist
              await client.query(`ALTER TABLE state_liquidity_pools ADD COLUMN IF NOT EXISTS virtual_token_reserve DOUBLE PRECISION DEFAULT 0`).catch(() => {});
              await client.query(`ALTER TABLE state_liquidity_pools ADD COLUMN IF NOT EXISTS virtual_usd_reserve DOUBLE PRECISION DEFAULT 0`).catch(() => {});

              await client.query(
                  `INSERT INTO state_liquidity_pools (token_symbol, token_reserve, usd_reserve, virtual_token_reserve, virtual_usd_reserve)
                   SELECT * FROM UNNEST($1::varchar[], $2::float8[], $3::float8[], $4::float8[], $5::float8[])
                   ON CONFLICT (token_symbol) DO UPDATE
                       SET token_reserve = EXCLUDED.token_reserve,
                           usd_reserve   = EXCLUDED.usd_reserve,
                           virtual_token_reserve = EXCLUDED.virtual_token_reserve,
                           virtual_usd_reserve   = EXCLUDED.virtual_usd_reserve`,
                  [lpTickers, lpTokenReserves, lpUsdReserves, lpVirtualTokens, lpVirtualUsd]
              );
          }
          
          await client.query('COMMIT');

          // Limitation 5 FIX — Prune stale zero-balance rows from state tables.
          // Runs asynchronously after the commit so it doesn't block the mining pipeline.
          pool.query('DELETE FROM state_balances WHERE balance <= 0').catch(() => {});
          pool.query('DELETE FROM state_usd_balances WHERE balance <= 0').catch(() => {});

      } catch (e) {
          await client.query('ROLLBACK');
          console.error(chalk.red("[STATE] PostgreSQL Snapshot bulk upsert failed:"), e);
      } finally {
          client.release();
          this.isSaving = false;
          if (this.saveQueue) this.saveSnapshot(lastIndex);
      }
  }
}

export default State;
