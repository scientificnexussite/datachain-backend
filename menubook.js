import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import pool from './db.js';
// IMPROVEMENT 4 — Static import instead of dynamic import() inside the trade
// hot path.  Using a top-level import eliminates per-call module resolution
// overhead and ensures referral errors are never silently swallowed.
import mempool from './mempool.js';

// ─── Schema ───────────────────────────────────────────────────────────────────
pool.query(`
    CREATE TABLE IF NOT EXISTS menubook_store (
        id INT PRIMARY KEY,
        data JSONB
    );
`).catch(err => console.error(chalk.red('[DB] MenuBook table init failed'), err));

// ─── Utilities ────────────────────────────────────────────────────────────────
const fixDust = (num) => Number(num.toFixed(8));

// ─── MenuBook ─────────────────────────────────────────────────────────────────
class MenuBook {
  constructor() {
    this.books = { SYR: { bids: [], asks: [], lastTradePrice: 0.01 } };
    this.orderCounter = 0;
    this.activeMintLocks = {};
    this.deployFeeLocks = {};

    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
    this.ordersFile = path.join(volumePath, 'orders.json');

    this.isSaving = false;

    // Bug 6 FIX — Replace the single saveQueue string/boolean with a Set of
    // pending tokens.  This way if token A is saving and tokens B AND C both
    // queue up concurrently, both B and C are remembered and both get their
    // MENUBOOK_UPDATE broadcast when the save drains, rather than C silently
    // overwriting B and causing a stale order book in the UI.
    this.saveQueueTokens = new Set();

    this.isInitializing = this.loadOrders();
  }

  // ── Boot gate ──────────────────────────────────────────────────────────────
  async ensureLoaded() {
    if (this.isInitializing) {
      await this.isInitializing;
      this.isInitializing = null;
    }
  }

  // ── Token book initialiser ─────────────────────────────────────────────────
  _initTokenBook(token) {
    if (!this.books[token]) {
      this.books[token] = {
        bids: [],
        asks: [],
        lastTradePrice: token === 'SYR' ? 0.01 : 0
      };
    }
  }

  // ── Load orders from PostgreSQL → JSON fallback ────────────────────────────
  async loadOrders() {
    try {
      const res = await pool.query('SELECT data FROM menubook_store WHERE id = 1');
      if (res.rows.length > 0) {
        const data = res.rows[0].data;
        this.books = data.books || { SYR: { bids: [], asks: [], lastTradePrice: 0.01 } };
        this.orderCounter = data.orderCounter || 0;
        this.activeMintLocks = data.activeMintLocks || {};
        this.deployFeeLocks = data.deployFeeLocks || {};
        console.log(chalk.green('[MENU BOOK] Orders successfully loaded from PostgreSQL.'));
        return;
      }
    } catch (e) {
      console.warn(chalk.yellow('[MENU BOOK] PostgreSQL load empty or unavailable. Checking local JSON fallback...'));
    }

    try {
      if (fs.existsSync(this.ordersFile)) {
        const data = JSON.parse(fs.readFileSync(this.ordersFile, 'utf8'));
        this.books = data.books || { SYR: { bids: [], asks: [], lastTradePrice: 0.01 } };
        this.orderCounter = data.orderCounter || 0;
        this.activeMintLocks = data.activeMintLocks || {};
        this.deployFeeLocks = data.deployFeeLocks || {};
        console.log(chalk.green('[MENU BOOK] Orders loaded from disk JSON. Migrating to DB...'));
        await this.saveOrders();
      }
    } catch (e) {
      console.warn(chalk.yellow('[MENU BOOK] No persistent orders found — starting fresh.'));
      this.activeMintLocks = {};
      this.deployFeeLocks = {};
    }
  }

  // ── Persist orders to disk + DB ────────────────────────────────────────────
  // IMPROVEMENT 2 — saveOrders() accepts an optional changedToken parameter.
  // Only that token's MENUBOOK_UPDATE event is broadcast instead of blasting
  // every token on every save.  This prevents O(n) WebSocket messages per trade.
  //
  // Bug 6 FIX — saveQueueTokens is now a Set so multiple concurrent callers
  // with different tokens all get their broadcasts when the save drains.
  async saveOrders(changedToken = null) {
    if (this.isSaving) {
      // Queue this token (or null = "all tokens") for a follow-up save
      if (changedToken) {
        this.saveQueueTokens.add(changedToken);
      } else {
        // null means "broadcast all" — signal with a special sentinel
        this.saveQueueTokens.add('__ALL__');
      }
      return;
    }
    this.isSaving = true;

    const data = {
      books: this.books,
      orderCounter: this.orderCounter,
      activeMintLocks: this.activeMintLocks,
      deployFeeLocks: this.deployFeeLocks
    };

    // JSON backup with atomic write (tmp → rename)
    try {
      const tempFile = this.ordersFile + '.tmp';
      await fs.promises.writeFile(tempFile, JSON.stringify(data, null, 2));
      await fs.promises.rename(tempFile, this.ordersFile);
    } catch (e) {
      console.error(chalk.red('[MENU BOOK] Failed to write JSON backup.'));
    }

    // PostgreSQL upsert
    try {
      await pool.query(
        'INSERT INTO menubook_store (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1',
        [data]
      );
    } catch (e) {
      console.error(chalk.red('[MENU BOOK] PostgreSQL sync failed:'), e);
    } finally {
      this.isSaving = false;

      // IMPROVEMENT 2 — Targeted broadcast
      if (global.broadcastWS) {
        const tokensToEmit = changedToken ? [changedToken] : Object.keys(this.books);
        for (const token of tokensToEmit) {
          if (this.books[token]) {
            global.broadcastWS('MENUBOOK_UPDATE', {
              token,
              ...this.books[token],
              marketData: this.getSpread(token)
            });
          }
        }
      }

      // Bug 6 FIX — Drain the Set: collect all queued tokens, clear the set,
      // then do a single follow-up save covering all of them.
      if (this.saveQueueTokens.size > 0) {
        const broadcastAll = this.saveQueueTokens.has('__ALL__');
        const pendingTokens = new Set(this.saveQueueTokens);
        this.saveQueueTokens.clear();

        // One save call; pass null if any of the queued tokens was __ALL__
        this.saveOrders(broadcastAll ? null : [...pendingTokens][0]);

        // If more than one real token queued up, broadcast each individually
        // on the next iteration by re-queuing the rest
        if (!broadcastAll && pendingTokens.size > 1) {
          const allTokens = [...pendingTokens];
          for (let i = 1; i < allTokens.length; i++) {
            this.saveQueueTokens.add(allTokens[i]);
          }
        }
      }
    }
  }

  // ── Mint locks (prevent duplicate deploys) ─────────────────────────────────
  hasMintLock(uid) {
    const lockTime = this.activeMintLocks ? this.activeMintLocks[uid] : null;
    if (!lockTime) return false;
    // Auto-expire after 15 minutes so a failed deploy doesn't freeze the user
    if (Date.now() - lockTime > 15 * 60 * 1000) {
      delete this.activeMintLocks[uid];
      this.saveOrders();
      return false;
    }
    return true;
  }

  addMintLock(uid) {
    if (!this.activeMintLocks) this.activeMintLocks = {};
    this.activeMintLocks[uid] = Date.now();
    this.saveOrders();
  }

  removeMintLock(uid) {
    if (this.activeMintLocks && this.activeMintLocks[uid]) {
      delete this.activeMintLocks[uid];
      this.saveOrders();
    }
  }

  // ── Deploy fee locks (prevent double-spend before mint is mined) ───────────
  addDeployFeeLock(uid, amount) {
    if (!this.deployFeeLocks) this.deployFeeLocks = {};
    if (!this.deployFeeLocks[uid]) this.deployFeeLocks[uid] = 0;
    this.deployFeeLocks[uid] += amount;
    this.saveOrders();
  }

  removeDeployFeeLock(uid, amount) {
    if (this.deployFeeLocks && this.deployFeeLocks[uid]) {
      this.deployFeeLocks[uid] -= amount;
      if (this.deployFeeLocks[uid] <= 0) delete this.deployFeeLocks[uid];
      this.saveOrders();
    }
  }

  // ── Price seed ─────────────────────────────────────────────────────────────
  async setInitialPrice(price, token = 'SYR') {
    await this.ensureLoaded();
    this._initTokenBook(token);
    this.books[token].lastTradePrice = price;
    await this.saveOrders(token);
  }

  // ── Balance query helpers (used by API balance guards) ─────────────────────
  getLockedUsd(uid, token = 'SYR') {
    this._initTokenBook(token);
    return fixDust(
      this.books[token].bids
        .filter(b => b.uid === uid)
        .reduce((sum, b) => sum + (b.amountSyr * b.priceUsd), 0)
    );
  }

  getLockedToken(uid, token = 'SYR') {
    this._initTokenBook(token);
    let locked = fixDust(
      this.books[token].asks
        .filter(a => a.uid === uid)
        .reduce((sum, a) => sum + a.amountSyr, 0)
    );
    // Add any pending deploy-fee lock held against this wallet's SYR
    if (token === 'SYR' && this.deployFeeLocks && this.deployFeeLocks[uid]) {
      locked += this.deployFeeLocks[uid];
    }
    return fixDust(locked);
  }

  // ── Spread calculator ──────────────────────────────────────────────────────
  getSpread(token = 'SYR') {
    this._initTokenBook(token);
    const highestBid = this.books[token].bids.length > 0 ? this.books[token].bids[0].priceUsd : 0;
    const lowestAsk  = this.books[token].asks.length > 0 ? this.books[token].asks[0].priceUsd : 0;
    const spread = (highestBid > 0 && lowestAsk > 0) ? fixDust(lowestAsk - highestBid) : 0;
    return { highestBid, lowestAsk, spread, lastTradePrice: this.books[token].lastTradePrice };
  }

  // ── Limit order placement ──────────────────────────────────────────────────
  async addLimitOrder(uid, side, amountSyr, priceUsd, token = 'SYR') {
    await this.ensureLoaded();
    this._initTokenBook(token);

    const order = {
      id: ++this.orderCounter,
      uid,
      amountSyr: fixDust(amountSyr),
      priceUsd: fixDust(priceUsd),
      timestamp: Date.now()
    };

    if (side === 'BUY') {
      this.books[token].bids.push(order);
      this.books[token].bids.sort((a, b) => b.priceUsd - a.priceUsd || a.timestamp - b.timestamp);
    } else if (side === 'SELL') {
      this.books[token].asks.push(order);
      this.books[token].asks.sort((a, b) => a.priceUsd - b.priceUsd || a.timestamp - b.timestamp);
    }

    console.log(chalk.cyan(`[MENU BOOK] Limit ${side} added: ${amountSyr} ${token} @ $${priceUsd}`));
    // IMPROVEMENT 2 — pass the specific token so only its events are broadcast
    await this.saveOrders(token);
    return order;
  }

  // ── Market order matching ──────────────────────────────────────────────────
  // IMPROVEMENT 4 — Referral logic has been removed from this hot path.
  // It now lives in a standalone exported function processReferralBonus()
  // below, called by api.js after a successful order execution.  This
  // eliminates dynamic import() inside a loop, prevents silent error
  // swallowing, and fixes the N-referral-checks-per-multi-fill bug.
  async matchMarketOrder(uid, side, amountSyr, availableFunds, limitPrice = null, token = 'SYR') {
    await this.ensureLoaded();
    this._initTokenBook(token);

    if (availableFunds <= 1e-8) {
      return { trades: [], remaining: fixDust(amountSyr), totalUsdCost: 0, slippage: 0, executedSyr: 0 };
    }

    let remaining = fixDust(amountSyr);
    if (side === 'SELL' && remaining > availableFunds) {
      remaining = fixDust(availableFunds);
    }

    let totalUsdCost = 0;
    let trades = [];

    const targetBook = side === 'BUY' ? this.books[token].asks : this.books[token].bids;
    let initialPrice = targetBook.length > 0 ? targetBook[0].priceUsd : this.books[token].lastTradePrice;

    let bookIndex = 0;
    while (remaining > 1e-8 && bookIndex < targetBook.length) {
      const topOrder = targetBook[bookIndex];

      // Self-trade prevention
      if (topOrder.uid === uid && topOrder.uid !== 'system') {
        bookIndex++;
        continue;
      }

      // Limit-price boundary enforcement
      if (limitPrice !== null) {
        if (side === 'BUY'  && topOrder.priceUsd > limitPrice) break;
        if (side === 'SELL' && topOrder.priceUsd < limitPrice) break;
      }

      let tradeAmount = fixDust(Math.min(remaining, topOrder.amountSyr));
      let tradeUsd    = fixDust(tradeAmount * topOrder.priceUsd);

      // Clip trade to remaining budget (BUY side only)
      if (side === 'BUY' && (totalUsdCost + tradeUsd) > availableFunds) {
        tradeAmount = fixDust((availableFunds - totalUsdCost) / topOrder.priceUsd);
        tradeUsd    = fixDust(tradeAmount * topOrder.priceUsd);
        if (tradeAmount <= 1e-8) break;
      }

      trades.push({
        buyer:     side === 'BUY'  ? uid : topOrder.uid,
        seller:    side === 'SELL' ? uid : topOrder.uid,
        amountSyr: tradeAmount,
        amountUsd: tradeUsd,
        price:     topOrder.priceUsd,
        tokenSymbol: token
      });

      this.books[token].lastTradePrice = topOrder.priceUsd;
      totalUsdCost = fixDust(totalUsdCost + tradeUsd);
      remaining    = fixDust(remaining - tradeAmount);
      topOrder.amountSyr = fixDust(topOrder.amountSyr - tradeAmount);

      if (topOrder.amountSyr <= 1e-8) {
        targetBook.splice(bookIndex, 1);
      }

      if (side === 'BUY' && totalUsdCost >= availableFunds) break;
    }

    const finalPrice = trades.length > 0 ? trades[trades.length - 1].price : initialPrice;
    let slippage = 0;
    if (initialPrice > 0 && trades.length > 0) {
      slippage = fixDust(Math.abs(finalPrice - initialPrice) / initialPrice);
    }

    // IMPROVEMENT 2 — only broadcast the changed token's book
    await this.saveOrders(token);
    return {
      trades,
      remaining,
      totalUsdCost,
      slippage,
      executedSyr: fixDust(amountSyr - remaining)
    };
  }

  // ── User order queries ─────────────────────────────────────────────────────
  getUserOrders(uid, token = 'SYR') {
    this._initTokenBook(token);
    const userBids = this.books[token].bids
      .filter(b => b.uid === uid)
      .map(b => ({ ...b, side: 'BUY', tokenSymbol: token }));
    const userAsks = this.books[token].asks
      .filter(a => a.uid === uid)
      .map(a => ({ ...a, side: 'SELL', tokenSymbol: token }));
    return [...userBids, ...userAsks].sort((a, b) => b.timestamp - a.timestamp);
  }

  // ── Order cancellation ─────────────────────────────────────────────────────
  async cancelOrder(uid, orderId, token = 'SYR') {
    await this.ensureLoaded();
    this._initTokenBook(token);

    const bidIndex = this.books[token].bids.findIndex(b => b.id === orderId && b.uid === uid);
    if (bidIndex !== -1) {
      this.books[token].bids.splice(bidIndex, 1);
      await this.saveOrders(token);
      return true;
    }

    const askIndex = this.books[token].asks.findIndex(a => a.id === orderId && a.uid === uid);
    if (askIndex !== -1) {
      this.books[token].asks.splice(askIndex, 1);
      await this.saveOrders(token);
      return true;
    }

    return false;
  }
}

// ─── IMPROVEMENT 4: Standalone referral processor ─────────────────────────────
// Moved out of matchMarketOrder() hot path so it:
//   • Uses a static top-level import (no dynamic import() in loops)
//   • Is properly await-ed by the caller in api.js
//   • Only fires once per order execution (not once per matched fill)
//   • Surfaces errors visibly rather than swallowing them in .then()
export async function processReferralBonus(uid, trades, token) {
  if (!trades || trades.length === 0) return;

  try {
    const refRes = await pool.query(
      'SELECT referrer_uid, created_at FROM referrals WHERE referred_uid = $1',
      [uid]
    );
    if (refRes.rows.length === 0) return;

    const { referrer_uid, created_at } = refRes.rows[0];

    // Referral bonus is only valid for the first 30 days after sign-up
    if (Date.now() - parseInt(created_at) >= 30 * 24 * 60 * 60 * 1000) return;

    // Aggregate total trade volume across all fills for this execution
    const totalTradeAmount = trades.reduce((sum, t) => sum + t.amountSyr, 0);
    const bonusSyr = Number(Number(totalTradeAmount * 0.001).toFixed(8));

    if (bonusSyr > 1e-8) {
      await mempool.addTransaction({
        from: 'system',
        to: referrer_uid,
        amount: bonusSyr,
        type: 'MINT',
        tokenSymbol: token,
        timestamp: Date.now(),
        isSystemGenerated: true,
        description: 'Referral Bonus'
      });

      pool.query(
        'INSERT INTO referral_earnings (referrer_uid, amount_syr, earned_at) VALUES ($1, $2, $3)',
        [referrer_uid, bonusSyr, Date.now()]
      ).catch(() => {});

      console.log(chalk.cyan(`[REFERRAL] Bonus of ${bonusSyr} ${token} queued for ${referrer_uid.substring(0, 12)}...`));
    }
  } catch (e) {
    // Log but don't let referral errors bubble up and kill the trade response
    console.error(chalk.yellow('[REFERRAL] Bonus processing failed:'), e.message);
  }
}

export default new MenuBook();
