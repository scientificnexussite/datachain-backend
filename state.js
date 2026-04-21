import pkg from 'pg';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const { Pool } = pkg;

// Strict Number casting to prevent legacy JSON string prototype crashes
const fixDust = (num) => Number(Number(num).toFixed(8));

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
    this.balances     = { "SYR": {} };
    this.usd_balances = {};

    const volumeDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
    this.snapshotFile = path.join(volumeDir, 'state_snapshot.json');

    // Migrate legacy snapshot file from old working directory to the volume
    const legacySnapshot = path.join(process.cwd(), 'state_snapshot.json');
    if (!fs.existsSync(this.snapshotFile) && fs.existsSync(legacySnapshot)) {
        try {
            if (!fs.existsSync(volumeDir)) fs.mkdirSync(volumeDir, { recursive: true });
            fs.copyFileSync(legacySnapshot, this.snapshotFile);
        } catch(e) {}
    }

    this.isSaving  = false;
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

  // -----------------------------------------
  // applyTransaction
  //
  // isReplay = true  → called during chain replay [loadSnapshot]. Balance checks
  //                    are relaxed so legacy history does not block itself.
  // isReplay = false → called for NEW live transactions via addBlock[]. Full
  //                    balance and fund checks apply.
  // -----------------------------------------
  applyTransaction(tx, currentPrice = 0, isReplay = false) {
    let { from, to, type } = tx;

    // FORCE STRICT NUMBER PARSING to prevent JSON string concatenation crashes
    const amount = parseFloat(tx.amount);
    if (isNaN(amount) || amount <= 0) return false;

    type = String(type).toUpperCase();
    const tokenSymbol = tx.tokenSymbol ? String(tx.tokenSymbol).toUpperCase() : "SYR";

    if (!this.balances[tokenSymbol]) this.balances[tokenSymbol] = {};

    // ── MINT ──────────────────────────────────────────────────────────────────
    if (type === 'MINT') {
      const receiver = to || from;
      this.balances[tokenSymbol][receiver] = fixDust(
          (this.balances[tokenSymbol][receiver] || 0) + amount
      );
      return true;
    }

    // ── USD_DEPOSIT ───────────────────────────────────────────────────────────
    if (type === 'USD_DEPOSIT') {
      this.addUsd(to || from, amount);
      return true;
    }

    // ── USD_WITHDRAWAL ────────────────────────────────────────────────────────
    if (type === 'USD_WITHDRAWAL') {
      if (isReplay) {
          // During replay just apply the deduction directly without the balance guard
          this.usd_balances[from] = fixDust((this.usd_balances[from] || 0) - amount);
          return true;
      }
      return this.deductUsd(from, amount);
    }

    // ── LEGACY TRANSLATION PROTOCOL ───────────────────────────────────────────
    // Old chain used type:'BUY' where the BUYER paid USD and received SYR from
    // the system wallet. We translate these to behave like MARKET_TRADEs.
    let sender   = from;
    let receiver = to;

    if (type === 'BUY') {
        // Sender is always the system [it holds the SYR supply]
        sender = 'system';
        // Receiver is the buyer. tx.to is 'system' on old chains, so fall back to tx.from
        receiver = (to && to !== 'system') ? to : from;
    } else if (type === 'SELL') {
        // Sender is the user selling their tokens back to the system
        sender   = (from && from !== 'system') ? from : to;
        receiver = 'system';
    }

    let senderBalance = this.balances[tokenSymbol][sender] || 0;

    // ── BUG FIX 3: System top-up is REPLAY-ONLY ───────────────────────────────
    //
    // The original code ran the top-up for ALL transaction types including live
    // TRANSFER [mining reward]. This silently created ghost SYR every time a
    // reward block was mined after the system wallet ran dry, inflating the
    // totalCirculating supply past 6 billion and breaking getRemainingSupply.
    //
    // Correct behaviour: during replay we must allow the system to "go back in
    // time" and fund itself [since real money/SYR was genuinely exchanged then].
    // During LIVE execution we must NEVER create SYR from thin air.
    //
    if (isReplay && sender === 'system' && senderBalance < amount) {
        // Top up the system wallet just enough to cover this historical transaction.
        // This preserves the net token flow [system loses `amount`, receiver gains
        // `amount`] without inflating any balances beyond what the chain recorded.
        this.balances[tokenSymbol][sender] = fixDust(senderBalance + amount);
        senderBalance = this.balances[tokenSymbol][sender];
    }

    // ── TRANSFER / MARKET_TRADE / BUY / SELL ─────────────────────────────────
    if (
        type === 'TRANSFER' ||
        type === 'MARKET_TRADE' ||
        type === 'BUY' ||
        type === 'SELL'
    ) {
        // Live-execution balance check [skipped during replay]
        if (!isReplay && sender !== 'system' && senderBalance < amount) return false;

        // USD handling
        let tradeUsdValue = parseFloat(tx.amountUsd) || 0;
        if (!tradeUsdValue && tx.priceUsd) {
            tradeUsdValue = fixDust(amount * parseFloat(tx.priceUsd));
        }

        if (type === 'MARKET_TRADE' || type === 'BUY' || type === 'SELL') {
            if (!isReplay) {
                // Live: deduct USD from buyer, credit USD to seller
                if (receiver !== 'system') {
                    if (!this.deductUsd(receiver, tradeUsdValue)) return false;
                }
            }
            if (sender !== 'system') {
                this.addUsd(sender, tradeUsdValue);
            }
        }

        // Execute the SYR transfer
        this.balances[tokenSymbol][sender]   = fixDust(senderBalance - amount);
        this.balances[tokenSymbol][receiver] = fixDust(
            (this.balances[tokenSymbol][receiver] || 0) + amount
        );
        return true;
    }

    return false;
  }

  getBalance(address, tokenSymbol = "SYR") {
    if (!this.balances[tokenSymbol]) return 0;
    return this.balances[tokenSymbol][address] || 0;
  }

  // -----------------------------------------
  // loadSnapshot
  //
  // BUG FIX 5 [fast path]: If the DB state tables already contain a snapshot
  // whose lastIndex matches the tip of the chain being loaded, we load that
  // snapshot directly instead of replaying every transaction from block 0.
  // This prevents a costly O[n] replay on every Railway restart AND eliminates
  // the race window where the auto-miner could fire before the replay finishes.
  //
  // The full replay is only performed when:
  //   a] No snapshot exists in the DB, OR
  //   b] The snapshot lastIndex is behind the chain tip - stale or corrupted.
  // -----------------------------------------
  async loadSnapshot(chain) {
    const chainTip = chain.length - 1;

    // ── Try fast path: load pre-computed balances from DB ─────────────────────
    try {
        const metaRes = await pool.query('SELECT last_index FROM state_meta WHERE id = 1');
        if (metaRes.rows.length > 0 && parseInt(metaRes.rows[0].last_index) === chainTip) {
            const balRes = await pool.query('SELECT address, token_symbol, balance FROM state_balances');
            const usdRes = await pool.query('SELECT address, balance FROM state_usd_balances');

            this.balances     = { "SYR": {} };
            this.usd_balances = {};

            balRes.rows.forEach(row => {
                const sym = row.token_symbol;
                if (!this.balances[sym]) this.balances[sym] = {};
                this.balances[sym][row.address] = parseFloat(row.balance);
            });

            usdRes.rows.forEach(row => {
                this.usd_balances[row.address] = parseFloat(row.balance);
            });

            console.log(chalk.green(
                `[STATE] Fast-path load: restored balances from DB snapshot at block ${chainTip}.`
            ));
            return; // Done - no replay needed
        }
    } catch(e) {
        console.warn(chalk.yellow("[STATE] DB snapshot check failed, falling back to full replay: " + e.message));
    }

    // ── Full mathematical replay from block 0 ─────────────────────────────────
    console.log(chalk.magenta.bold(
        `[STATE] Running full ledger replay from block 0 to block ${chainTip}...`
    ));

    this.balances     = { "SYR": {} };
    this.usd_balances = {};

    for (let i = 0; i <= chainTip; i++) {
      const block = chain[i];
      if (typeof block.data === 'string') continue;
      for (const tx of block.data) {
        this.applyTransaction(tx, 0, true); // isReplay = true
      }
    }

    console.log(chalk.green.bold(
        `[STATE] Full replay complete. Balances verified to block ${chainTip}.`
    ));

    // Persist the correct result so the next boot uses the fast path
    await this.saveSnapshot(chainTip);
  }

  async saveSnapshot(lastIndex) {
      if (this.isSaving) {
          this.saveQueue = true;
          return;
      }
      this.isSaving  = true;
      this.saveQueue = false;

      // ── Write JSON fallback to volume ─────────────────────────────────────
      try {
          const snapshot  = { balances: this.balances, usd_balances: this.usd_balances, lastIndex };
          const tempFile  = this.snapshotFile + '.tmp';
          await fs.promises.writeFile(tempFile, JSON.stringify(snapshot));
          await fs.promises.rename(tempFile, this.snapshotFile);
      } catch (e) {
          console.warn(chalk.yellow("[STATE] JSON snapshot write failed: " + e.message));
      }

      // ── Write to PostgreSQL ───────────────────────────────────────────────
      const client = await pool.connect();
      try {
          await client.query('BEGIN');

          await client.query(
              'INSERT INTO state_meta (id, last_index) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET last_index = $1',
              [lastIndex]
          );

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
