import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import pool from './db.js'; // Issue #3 Fixed
// Receipt validation lives in receipts.js so the ledger, the epoch driver and the tests all
// apply exactly ONE definition of "is this batch well-formed and properly attested". Two
// copies of a consensus rule is two chances to disagree.
import {
    validateBatch as validateReceiptBatch,
    verifyAttestations as verifyReceiptAttestations
} from './receipts.js';

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

/* ── DEPLOY FEES ────────────────────────────────────────────────────────────────────
   Creating a token is NOT free on either product, and the two charge differently.

     DelChain  — $1.00 WORTH of SYR to `system`               (api.js:5227-5228)
     OpenChain — 1.00 SDX to `system`                         (api.js:4044)
                 PLUS the parent network owner's SYR fee      (api.js:4053-4079)

   These are the SAME two numbers as Exe/core/state-db.js:31-32, and they must stay the
   same: a node that charged a different amount would rebuild different balances from the
   very same block.

   SDX is used for the OpenChain platform fee for a concrete reason: it is pegged to $1,
   whereas $1 of SYR at the seed price is 100,000,000 SYR, which nobody holds — the fee was
   unpayable when it was denominated in SYR.
   ──────────────────────────────────────────────────────────────────────────────────── */
const DELCHAIN_DEPLOY_FEE_USD    = 1.00;
const OPENCHAIN_PLATFORM_FEE_SDX = 1.00;

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

    // ── THE TOKEN REGISTRIES, REBUILT FROM BLOCKS ──────────────────────────────────
    // Mirrors of the three tables Exe/core/state-db.js writes from a TOKEN_DEPLOY —
    // token_metadata (:129), open_tokens (:215) and open_token_supply (:231) — kept here
    // in memory so that replaying a chain on this node produces the same registry as
    // replaying it in the exe. Without them the deploy would move money on both sides but
    // leave only one side knowing the token exists.
    //
    // Deliberately NOT written back into api.js's Postgres tables of the same name: those
    // belong to the API layer, have entirely different columns (token_metadata there is
    // (ticker, description, logo_base64, fdx_tiers, public_url, updated_at)), and are
    // upserted by routes that know nothing about replay. State owns these copies and
    // persists them in its OWN snapshot file.
    //
    // Keyed by UPPERCASE ticker, exactly like `liquidityPools`.
    this.tokens          = {};   // DelChain registry  → token_metadata
    this.openTokens      = {};   // OpenChain registry → open_tokens
    this.openTokenSupply = {};   // where an OpenChain supply lives → open_token_supply

    // ── VERIFIED-WORK RECEIPTS, BY EPOCH ───────────────────────────────────────────
    // What each host was credited for one epoch's AI work: { epoch: {receipts, verifiers, at} }.
    // Rebuilt from RECEIPT transactions, so every node that replays the chain agrees on who
    // is owed what — the property the treasury needs before it can pay anyone.
    // A later batch for the same epoch REPLACES an earlier one; it is keyed, not appended.
    this.epochReceipts = {};

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

  // ── Token Registry Helpers ─────────────────────────────────────────────────
  // Read side of the three registries a TOKEN_DEPLOY writes. Named after their
  // Exe/core/state-db.js counterparts so the two can be compared field for field —
  // see Exe/tests/state-parity.test.mjs, which does exactly that.

  /** A DelChain token's record, or null. Mirrors state-db.getTokenMetadata. */
  getTokenMetadata(ticker) {
    return this.tokens[String(ticker || '').toUpperCase()] || null;
  }

  /** An OpenChain token's record, or null. Mirrors state-db.getOpenToken. */
  getOpenToken(ticker) {
    return this.openTokens[String(ticker || '').toUpperCase()] || null;
  }

  /** Which hidden address holds an OpenChain supply, and how much. */
  getOpenTokenSupply(ticker) {
    return this.openTokenSupply[String(ticker || '').toUpperCase()] || null;
  }

  /**
   * Move a token balance by `delta`, byte-for-byte like Exe/core/state-db.js adjustBalance.
   *
   * ⚠️ THE ASYMMETRY IS DELIBERATE AND MUST BE COPIED. Over there an EXISTING row is a
   * plain `amount = amount + delta` (which may go negative), while a row that does not
   * exist yet is INSERTed with `Math.max(0, delta)` — so a fee charged to an address that
   * has never held that token floors at zero instead of going negative. Two nodes that
   * disagreed about that single case would rebuild different balances from the same block,
   * which is the whole failure this branch exists to prevent.
   *
   * `fixDust` is applied because every other write in this file does; the exe stores raw
   * floats. The two therefore agree to 8 decimal places, which is this ledger's canonical
   * precision (fixDust) and the precision the deploy routes already round their fees to.
   */
  _adjustBalance(address, tokenSymbol, delta) {
    if (!address) return;
    const t = String(tokenSymbol || 'SYR').toUpperCase();
    if (!this.balances[t]) this.balances[t] = {};
    const book = this.balances[t];
    book[address] = Object.prototype.hasOwnProperty.call(book, address)
      ? fixDust(book[address] + delta)
      : fixDust(Math.max(0, delta));
  }

  /**
   * Charge one deploy fee. Mirrors Exe/core/state-db.js _payFee (:636-643).
   *
   * `system` is the SYR mint authority and its balance is NOT tracked in this ledger — the
   * transfer path below skips crediting it for exactly the same reason. Crediting it here
   * would invent a balance the exe does not have.
   */
  _payDeployFee(payer, tokenSymbol, amount, to) {
    if (!(amount > 0)) return;
    this._adjustBalance(payer, tokenSymbol, -amount);
    if (to && to !== 'system') this._adjustBalance(to, tokenSymbol, amount);
  }

  /**
   * Charge a token deployment, as part of applying its transaction.
   *
   * Mirrors Exe/core/state-db.js _applyDeployFees (:612-634). It has to run HERE rather
   * than in the deploy route because balances are rebuilt from blocks: a fee taken outside
   * the transaction exists only on the machine that took it, and every other node — this
   * one included, after its next rebuild — would compute a balance a whole fee higher.
   */
  _applyDeployFees(payer, chain, meta) {
    if (!payer) return;
    if (chain === 'openchain') {
      // A CONSTANT, enforced here rather than read from the transaction. SDX is pegged to
      // $1 so this amount never depends on a price, which means every node can derive it
      // independently and none of them has to trust what the signer wrote. Reading
      // `meta.platformFeeSdx` would let whoever signs the deploy set their own fee to 0.
      this._payDeployFee(payer, 'SDX', OPENCHAIN_PLATFORM_FEE_SDX, 'system');

      // The parent network owner's cut. This one MUST come from the transaction: the fee
      // registry is not on the chain, so a replay has no other way to learn what was
      // charged, and reading today's table would reproduce a different number for a deploy
      // that happened months ago.
      const networkFee = Number(meta.networkFeeSyr) || 0;
      const networkTo  = String(meta.networkFeeTo || '');
      if (networkFee > 0 && networkTo) this._payDeployFee(payer, 'SYR', networkFee, networkTo);
    } else {
      // $1.00 WORTH of SYR. The SYR amount depends on the price at the moment of creation,
      // which no replay can recover, so the deploy route prices it once and records the
      // result in the signed transaction.
      const feeSyr = Number(meta.feeSyr) || 0;
      if (feeSyr > 0) this._payDeployFee(payer, 'SYR', feeSyr, 'system');
    }
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
      // A CHECKPOINT is a commitment ENVELOPE and may carry any of several roots: the model
      // checkpoint, the state snapshot, and the treasury's pending-payment queue. It is
      // valid if AT LEAST ONE is well-formed.
      //
      // ⚠️ THIS USED TO REQUIRE `tx.root` SPECIFICALLY. An epoch that had only a pending
      // queue to commit — no new model checkpoint, no new snapshot — emits a transaction
      // with `root: null`, which the old test rejected. That is a block the epoch driver
      // builds and the ledger refuses: an instant fork, in exactly the case the pending
      // root exists to protect (debts carried, nothing else happening).
      const wellFormed = (r) => typeof r === 'string' && /^[0-9a-f]{64}$/i.test(r);

      // A malformed root is worse than no commitment: nodes would "agree" on a root that
      // verifies nothing, so every proof against it fails silently. So reject a transaction
      // that carries a malformed root even when another root is fine — a half-valid
      // commitment is a commitment nobody can trust.
      const present = [tx.root, tx.checkpointRoot, tx.snapshotRoot, tx.pendingRoot]
          .filter(r => r !== null && r !== undefined && r !== '');
      if (present.length === 0 || !present.every(wellFormed)) {
        if (!isReplay) console.log(chalk.red('[LEDGER] Rejected CHECKPOINT: no well-formed Merkle root.'));
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

    // TOKEN_DEPLOY — a new token, recorded ON-CHAIN.
    //
    // WHY IT IS ON THE CHAIN AT ALL. The token registry never was: it lived in this
    // server's Postgres, which is why a node with no primary could not create a token and
    // reported a stale list. Carrying the definition in a transaction makes the registry
    // replicated, rebuildable from blocks, and independent of any server — exactly like
    // balances. Exe/core/state-db.js:464-531 is the live implementation; this branch is its
    // mirror and the two are pinned together by Exe/tests/state-parity.test.mjs.
    //
    // ⚠️ CONSENSUS NOTE — THIS IS THE URGENT ONE. Exe/core/miner.js now puts mempool
    // transactions into blocks, so TOKEN_DEPLOY reaches the wire. A node without this
    // branch falls through to `return false`, datachain.js:572 drops the transaction, and
    // it builds a DIFFERENT block from the same input. That is a fork — the same class of
    // bug as the coinbase type mismatch that cost this project 955 blocks.
    //
    // Handled BEFORE the ledger lock, like CHECKPOINT and NODE_ANNOUNCE above, and for two
    // concrete reasons rather than one:
    //   · the exe registers a token even when the supply is 0 (`if (amt > 0)` guards only
    //     the credit), and the lock rejects amount <= 0;
    //   · the lock also rejects amount > 100,000,000,000, while the exe's deploy route
    //     allows a supply up to 1e15 and its applyTransaction caps nothing at all.
    // Either case would be accepted by the exe and dropped here. Both are forks.
    if (String(type).toUpperCase() === 'TOKEN_DEPLOY') {
      // `amount` is the initial supply. There is no sender: like MINT, this brings a new
      // asset into existence. WHO receives it depends on the product — see below.
      const amt  = parseFloat(tx.amount) || 0;
      const meta = (tx.token && typeof tx.token === 'object') ? tx.token : {};
      // Uppercased, as every other type in this file is. The deploy routes uppercase the
      // ticker before signing (local-api.js:1091, :1179), so this and the exe's raw symbol
      // are the same string for anything a route can produce.
      const ticker = String(tx.tokenSymbol || 'SYR').toUpperCase();
      const creator = from;

      // ── WHICH PRODUCT ────────────────────────────────────────────────────────────
      // ⚠️ READ THE SERVER-SET `chain` FIELD, NEVER A CLIENT `openChain` BOOLEAN.
      // DelChain and OpenChain charge different fees, send the supply to different places
      // and write to different registries, so letting the caller pick the label would let
      // anyone buy the cheap product and receive the expensive one. `chain` is set by the
      // deploy route after it has enforced that product's rules.
      const chain = String(meta.chain || '').toLowerCase() === 'openchain'
        ? 'openchain' : 'delchain';

      // ── FEES, DEBITED INSIDE THE TRANSACTION ─────────────────────────────────────
      this._applyDeployFees(creator, chain, meta);

      if (chain === 'openchain') {
        // The supply goes to a hidden, network-held address — NOT the creator's wallet
        // (api.js:4082-4099). The address is carried in the transaction because it is
        // generated randomly at creation: regenerating it here would put the supply
        // somewhere new on every replay.
        const supplyTo = String(meta.supplyTo || '') ||
                         ('nx_open_' + ticker.toLowerCase() + '_system');
        this.openTokens[ticker] = {
          ticker,
          uid: creator || '',
          name: String(meta.name || ticker).slice(0, 64),
          description: String(meta.description || '').slice(0, 500),
          logo_url: typeof meta.logo === 'string' ? meta.logo : '',
          parent_ticker: meta.parent ? String(meta.parent).toUpperCase() : null,
          total_supply: amt,
          status: 'active',
          created_at: Number(tx.timestamp) || Date.now()
        };
        this.openTokenSupply[ticker] = {
          ticker,
          system_address: supplyTo,
          total_supply: amt,
          created_at: Number(tx.timestamp) || Date.now()
        };
        if (amt > 0) this._adjustBalance(supplyTo, ticker, amt);
        // ⚠️ DELIBERATELY NOTHING IS WRITTEN TO `tokens` HERE.
        // That is the DelChain registry; an OpenChain row in it shows up on the DelChain
        // list as an independent coin, which it is not.
      } else {
        this.tokens[ticker] = {
          ticker,
          name: String(meta.name || ticker).slice(0, 64),
          creator: creator || '',
          total_supply: amt,
          circulating_supply: amt,
          created_at: Number(tx.timestamp) || Date.now(),
          description: String(meta.description || '').slice(0, 500),
          is_open_token: 0,
          network: meta.network || 'mainnet',
          // ⚠️ TOP LEVEL, NOT NESTED UNDER `data`. state-db.setTokenMetadata serialises the
          // WHOLE object into its `data` column, so a `data:` key here would be double
          // encoded and every reader would find `website` undefined.
          logo: typeof meta.logo === 'string' ? meta.logo : null,
          website: typeof meta.website === 'string' ? meta.website : null,
          // Recorded but NOT trusted: a domain counts as verified only once a proof has
          // been checked, and DNS can change after the fact — so the flag is never written
          // to the chain, it is re-derived locally. See local-api /api/token/verify-domain.
          domainVerified: false,
          // What was actually paid, kept with the token so the charge is auditable from the
          // registry and not only from the block.
          deployFeeSyr: Number(meta.feeSyr) || 0
        };
        if (amt > 0) this._adjustBalance(creator, ticker, amt);
      }

      // ⚠️ ALWAYS TRUE. Never refuse a deploy for insufficient funds the way the transfer
      // path does: the exe applies it regardless (its balance floor is the Math.max(0, …)
      // in _adjustBalance), so a refusal here would drop a transaction the exe keeps.
      return true;
    }

    // RECEIPT — the verified-work receipts for one epoch (M1, roadmap 13_BUILD_ROADMAP).
    //
    // Moves NO value: it records WHO did verified work and HOW MUCH, and the epoch driver
    // turns that into TRANSFERs later. Handled before the ledger lock for the same reason
    // as CHECKPOINT and NODE_ANNOUNCE — the lock rejects amount <= 0.
    //
    // WHY THIS IS ON THE CHAIN. A receipt causes SYR to be paid. If nodes learned receipts
    // from gossip instead, two nodes could hold different sets, settle different amounts,
    // and build different blocks — a fork over money. On-chain, the receipt set for an
    // epoch is whatever the chain says it is.
    //
    // ⚠️ CONSENSUS NOTE (as CHECKPOINT / NODE_ANNOUNCE / TOKEN_DEPLOY above): a node
    // without this branch falls through to `return false`, drops the transaction, and
    // builds a DIFFERENT block. Mirrored in Exe/core/state-db.js; the parity between the
    // two is pinned by Exe/tests/state-parity.test.mjs. Safe to ship today only because
    // epoch settlement is dormant (epoch.js EPOCH_1_HEIGHT = MAX_SAFE_INTEGER) and nothing
    // emits one yet.
    if (String(type).toUpperCase() === 'RECEIPT') {
      const epoch = Number(tx.epoch);
      const list = Array.isArray(tx.receipts) ? tx.receipts : null;

      const batch = validateReceiptBatch({ epoch, receipts: list });
      if (!batch.ok) {
        if (!isReplay) console.log(chalk.red(`[LEDGER] Rejected RECEIPT: ${batch.reason}.`));
        return false;
      }

      // THE QUORUM IS THE WHOLE SECURITY PROPERTY. Several distinct verifiers must have
      // signed this exact batch, so a host cannot pay itself — it cannot produce other
      // people's signatures. verifyAttestations counts one vote per key, so the same
      // verifier signing repeatedly does not reach quorum on its own.
      const quorum = verifyReceiptAttestations({
        epoch, receipts: list, attestations: tx.attestations
      });
      if (!quorum.ok) {
        if (!isReplay) {
          console.log(chalk.red(`[LEDGER] Rejected RECEIPT for epoch ${epoch}: ${quorum.reason} ` +
                                `(${quorum.signers.length} of ${quorum.required} verifiers).`));
        }
        return false;
      }

      // Keyed by epoch, so a later corrected batch REPLACES an earlier one rather than
      // both counting. receiptsForEpoch() reads newest-first for the same reason.
      this.epochReceipts[epoch] = {
        receipts: list,
        verifiers: quorum.signers,
        at: Number(tx.timestamp) || 0
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

  /**
   * Restore the three token registries from State's OWN snapshot file.
   *
   * They are not in Postgres: api.js's tables of the same name have different columns and
   * different owners (see the constructor), so State keeps its copies in the JSON snapshot
   * it already writes on every save. Registry rows only — balances still come from
   * Postgres, which stays authoritative for money.
   *
   * Safe to run before either path below. Every write is an assignment keyed on ticker, so
   * a later chain replay overwrites rather than accumulating: loading and then replaying
   * cannot double-apply.
   */
  _loadRegistriesFromFile() {
    try {
        if (!fs.existsSync(this.snapshotFile)) return;
        const snap = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8')) || {};
        if (snap.tokens          && typeof snap.tokens === 'object')          this.tokens = snap.tokens;
        if (snap.openTokens      && typeof snap.openTokens === 'object')      this.openTokens = snap.openTokens;
        if (snap.openTokenSupply && typeof snap.openTokenSupply === 'object') this.openTokenSupply = snap.openTokenSupply;
        // Receipts are fully re-derivable from RECEIPT transactions, unlike the token
        // registries above. Restoring them anyway means a node that has pruned old blocks
        // still knows what past epochs credited — and a replay simply overwrites, since
        // every write here is keyed on epoch.
        if (snap.epochReceipts   && typeof snap.epochReceipts === 'object')   this.epochReceipts = snap.epochReceipts;
        const n = Object.keys(this.tokens).length + Object.keys(this.openTokens).length;
        if (n > 0) console.log(chalk.cyan(`[STATE] Loaded ${n} token registry record(s) from snapshot.`));
    } catch (e) {
        console.warn(chalk.yellow('[STATE] Could not read the token registry snapshot:'), e.message);
    }
  }

  async loadSnapshot(chain) {
    // Tokens created BEFORE TOKEN_DEPLOY existed were never transactions, so no replay can
    // bring them back — they live only here. Loaded first so that both paths below start
    // from them, and never cleared afterwards.
    this._loadRegistriesFromFile();

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

        // ⚠️ `tokens`, `openTokens`, `openTokenSupply` AND `epochReceipts` ARE DELIBERATELY
        // NOT CLEARED.
        // Same invariant as Exe/core/state-db.js rebuildFromChain (:677-691), which is
        // explicit that no `DELETE FROM token_metadata` may ever be added there: tokens
        // that predate TOKEN_DEPLOY exist only in the snapshot, so clearing would erase
        // every one of them permanently on the next restart. Replay is idempotent without
        // clearing because each registry write is an assignment keyed on ticker, so
        // applying the same deploy twice is a no-op — the balances above are the only part
        // that ACCUMULATES, and those are the only part reset.

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
              // The three token registries. This file is the ONLY place they are persisted
              // — Postgres's tables of the same name belong to api.js and have different
              // columns — so leaving them out would lose every locally created token on
              // restart unless the whole chain happened to be replayed.
              tokens: this.tokens,
              openTokens: this.openTokens,
              openTokenSupply: this.openTokenSupply,
              // Verified-work receipts by epoch. Re-derivable from RECEIPT transactions, but
              // persisted so a node that prunes old blocks keeps the credit history.
              epochReceipts: this.epochReceipts,
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

// Published on the class so the fees can be asserted equal across the two implementations
// without re-typing the numbers in a test — Exe/core/state-db.js exposes them the same way
// (StateDB.DELCHAIN_DEPLOY_FEE_USD / .OPENCHAIN_PLATFORM_FEE_SDX). Two constants that
// silently drifted apart would charge two different fees for the same block.
State.DELCHAIN_DEPLOY_FEE_USD    = DELCHAIN_DEPLOY_FEE_USD;
State.OPENCHAIN_PLATFORM_FEE_SDX = OPENCHAIN_PLATFORM_FEE_SDX;

export default State;
