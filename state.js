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

    // THE NODE REGISTRY — the phone book that replaces editing nodes.js by hand.
    // Keyed by the announcing wallet address; value: { url, at, height }.
    // Every node that agrees to serve the website publishes its public address here with a
    // NODE_ANNOUNCE transaction, so the list lives on the chain rather than in a static file.
    // A node that changes address (a free tunnel gets a new one every restart) simply
    // announces again and overwrites its own entry — nobody edits or redeploys anything.
    this.nodes = {};

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
    // 'system' and 'fee_pool' are trusted virtual addresses — they can spend their
    // real balance. All other addresses must have sufficient funds first.
    const isTrustedVirtual = address === 'system' || address === 'fee_pool';
    if (!isTrustedVirtual && current < parsedAmount) return false;
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

    // CHECKPOINT (F15) — commits the epoch's model-checkpoint Merkle root on-chain, so every
    // node agrees on the one true model and can verify any chunk against it. It moves NO
    // value: it is accepted and recorded in the block, and no balance is touched.
    //
    // Checked BEFORE the ledger lock below deliberately. That guard rejects anything with
    // amount <= 0, and a checkpoint commitment legitimately has no amount — running it
    // through the value path would either drop the commitment or force a fake amount onto
    // a transaction that must never move funds.
    //
    // ⚠️ CONSENSUS NOTE: a node WITHOUT this branch falls through to `return false`, drops
    // the transaction, and therefore builds a DIFFERENT block than a node that accepts it.
    // This acceptance must be deployed everywhere BEFORE the first CHECKPOINT is emitted.
    // Safe today only because epoch settlement is dormant (epoch.js EPOCH_1_HEIGHT =
    // MAX_SAFE_INTEGER) and nothing emits one yet.
    if (String(type).toUpperCase() === 'CHECKPOINT') {
      const root = typeof tx.root === 'string' ? tx.root : '';
      // A malformed root is worse than no commitment: nodes would "agree" on a root that
      // verifies nothing, so every chunk proof against it fails silently.
      if (!/^[0-9a-f]{64}$/i.test(root)) {
        if (!isReplay) console.log(chalk.red('[LEDGER] Rejected CHECKPOINT: malformed Merkle root.'));
        return false;
      }
      return true;
    }

    // NODE_ANNOUNCE — a node publishes the public address it serves the website on.
    // Moves NO value, so like CHECKPOINT it is handled BEFORE the ledger lock, which
    // rejects anything with amount <= 0.
    //
    // WHY ON-CHAIN. The alternative is a list in a file (nodes.js) or on one server. A file
    // must be re-edited and re-deployed every time any node's address changes, and a server
    // is the single point of failure this whole exercise exists to remove. On-chain, the
    // registry is replicated by every node that already replicates the ledger, it survives
    // any individual machine going down, and it costs no new infrastructure.
    //
    // ⚠️ CONSENSUS NOTE (same as CHECKPOINT above): a node without this branch falls through
    // to `return false`, drops the transaction, and builds a DIFFERENT block. Every node must
    // run this build BEFORE the first NODE_ANNOUNCE is emitted. That is why announcing is
    // gated behind a settings flag that ships OFF — see Exe/core/announce.js.
    if (String(type).toUpperCase() === 'NODE_ANNOUNCE') {
      const url = typeof tx.url === 'string' ? tx.url.trim() : '';
      const owner = from || to;
      if (!owner) return false;

      // Retire an address by announcing an empty url — this is how a node says
      // "stop sending visitors to me" when it stops sharing.
      if (url === '') {
        delete this.nodes[owner];
        return true;
      }

      // HTTPS ONLY, and no credentials, no query, no port games. A browser on an https page
      // cannot call http at all, so an http entry would be dead weight that every visitor
      // wastes a timeout on. Rejecting it here keeps the registry free of unusable rows.
      if (url.length > 200) return false;
      let parsed;
      try { parsed = new URL(url); } catch (e) { return false; }
      if (parsed.protocol !== 'https:') return false;
      if (parsed.username || parsed.password) return false;
      if (parsed.search || parsed.hash) return false;
      if (parsed.pathname !== '/') return false;

      // One entry per address: re-announcing REPLACES, never appends. This is what makes a
      // rotating tunnel address free — and it caps the registry at one row per identity, so
      // it cannot be inflated into a denial-of-service by a single loud node.
      this.nodes[owner] = {
        url: parsed.origin,
        at: Number(tx.timestamp) || Date.now()
      };
      return true;
    }

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
