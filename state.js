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
// F6 security bonds. Same reasoning as receipts: ONE definition of "is this bond valid",
// shared by the ledger, the registry and the tests.
import { validateBond, canRelease, BOND_DEFAULTS } from './bonds.js';
// GOV_ROLE governance records (11 §9B): the SHAPE check, shared with Exe/core/gov-record.js.
import { isWellFormedGovRole } from './gov-record.js';
// KEY_REGISTER key-registry records (09/R116, D3): the SHAPE check, shared with Exe/core/key-record.js.
import { isWellFormedKeyRegister } from './key-record.js';
// One-time ledger corrections (consensus step 4.4, D1), shared with Exe/core/txrules.js.
import { correctionsAt, txId, rules2Active, RULES_DEFAULTS } from './txrules.js';
// On-chain trading (seven-phase plan Step 4): ONE engine for both ledgers (Exe/core/dex.js is its mirror).
import * as dex from './dex.js';
import { canonicalSpki } from './gov-record.js';
import { OWNER_KEY } from './key-record.js';
// Escrow (consensus step 4.5): where locked coins wait, shared with Exe/core/escrow.js.
import { ESCROW_ADDRESS } from './escrow.js';

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

    // ── F6 SECURITY BONDS ──────────────────────────────────────────────────────────
    // address -> { amount, verifierKey, since, releasableAt }. SYR that has been DEBITED
    // from the spendable balance and is held at risk to back a verifier identity.
    //
    // NOT the same thing as api.js's /stake/lock yield product, which is a plain TRANSFER
    // plus a Postgres row and is invisible to a replaying node. See bonds.js.
    //
    // ⚠️ Bonded SYR is not destroyed. Anything totalling circulating supply must add it
    // back, or bonding reads as a burn.
    this.bonds = {};

    // ── ON-CHAIN TRADING (Step 4, dex.js) ────────────────────────────────────────────
    // The book: markets, open orders, the ticker book, SDTX issuance. Derived from blocks like
    // balances; persisted with them. rules2Height / dexOwnerKey are instance values so tests can
    // switch RULES_2 on and use their own owner key (Exe/core/state-db.js does the same).
    this.dex = dex.emptyBook();
    this.rules2Height = RULES_DEFAULTS.RULES_2_HEIGHT;
    this.dexOwnerKey = OWNER_KEY;

    const volumeDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
    this.snapshotFile = path.join(volumeDir, 'state_snapshot.json');
    
    this.isSaving = false;
    this.saveQueue = false;
  }

  // ── on-chain trading helpers (Step 4) ─────────────────────────────────────────────
  _rules2(height) { return height !== null && height !== undefined && rules2Active(height, { RULES_2_HEIGHT: this.rules2Height }); }

  _dexCtx(tx, height) {
    return { height, id: txId(tx), signerKey: canonicalSpki(tx.publicKey), ownerKey: this.dexOwnerKey,
             balanceOf: (a, t) => (this.balances[t] || {})[a] || 0 };
  }

  /** A trading balance change, applied exactly as Exe/core/state-db.js _applyUnits applies it. */
  _setUnits(address, token, delta) {
    if (!this.balances[token]) this.balances[token] = {};
    this.balances[token][address] = dex.applyUnits(this.balances[token][address] || 0, delta);
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
  /**
   * One-time LEDGER CORRECTIONS (consensus step 4.4; txrules.LEDGER_CORRECTIONS): applied when
   * block `height` is applied, BEFORE its transactions — the same in Exe/core/state-db.js. Every
   * path that applies or replays a block calls this (datachain.js addBlock, chain-rules.js
   * applyBlockTo, the replays in loadSnapshot).
   */
  applyCorrections(height) {
    for (const c of correctionsAt(height)) {
      if (!this.balances[c.token]) this.balances[c.token] = {};
      this.balances[c.token][c.address] = c.setTo;
    }
  }

  /** Can `payer` afford this deploy's fees (the same amounts _applyDeployFees debits)? */
  _canPayDeployFees(payer, chain, meta) {
    const bal = (t) => (this.balances[t] && this.balances[t][payer]) || 0;
    if (chain === 'openchain') {
      if (bal('SDX') < OPENCHAIN_PLATFORM_FEE_SDX) return false;
      const networkFee = Number(meta.networkFeeSyr) || 0;
      if (networkFee > 0 && String(meta.networkFeeTo || '') && bal('SYR') < networkFee) return false;
      return true;
    }
    const feeSyr = Number(meta.feeSyr) || 0;
    return !(feeSyr > 0 && bal('SYR') < feeSyr);
  }

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

    // `floor` (consensus step 4.3): true for blocks from txrules.RULES_1_HEIGHT on — see TOKEN_DEPLOY.
    applyTransaction(tx, currentPrice = 0, isReplay = false, { floor = false, height = null } = {}) {
    let { from, to, type } = tx;

    // ON-CHAIN TRADING (Step 4): the engine decides — the same one Exe/core/state-db.js uses. Valid
    // only from RULES_2 (txrules), so a caller that does not say the height gets a refusal.
    if (dex.DEX_TYPES.includes(type)) {
      if (!this._rules2(height)) return false;
      const r = dex.applyDexTx(this.dex, tx, this._dexCtx(tx, height));
      if (!r.ok) { console.log(chalk.red(`[LEDGER] Rejected ${type}: ${r.why}`)); return false; }
      for (const [a, t, d] of r.deltas) this._setUnits(a, t, d);
      this.dex = r.book;
      return true;
    }

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
    // GOV_ROLE (2026-10-16; 11 §9B) — a governance appointment / removal / ban, signed by the
    // appointer. Moves no value. Accepted when WELL-FORMED (gov-record.js, the same check the
    // exe's state-db.js uses); who may make it, and whether the signature is genuine, is decided
    // where the role list is rebuilt from blocks (Exe/core/gov-registry.js), so an unauthorised
    // record changes nothing. ⚠️ CONSENSUS NOTE: as above, every node needs this branch before
    // the first GOV_ROLE is mined, or it builds a different block.
    if (String(type).toUpperCase() === 'GOV_ROLE') {
      if (!isWellFormedGovRole(tx)) {
        if (!isReplay) console.log(chalk.red('[LEDGER] Rejected GOV_ROLE: malformed record.'));
        return false;
      }
      return true;
    }

    // KEY_REGISTER (2026-10-17; 09/R116, D3) — binds a weak address to the full key it was cut
    // from, signed by that key AND co-signed by the owner. Moves no value. Accepted when
    // WELL-FORMED (key-record.js, the same check the exe's state-db.js uses); whether both
    // signatures are genuine and the address was still free is decided where the registry is
    // rebuilt from blocks and, from RULES_1_HEIGHT, by txrules.js for the whole block.
    // ⚠️ CONSENSUS NOTE: as above, every node needs this branch before the first one is mined.
    if (type === 'KEY_REGISTER') {
      if (!isWellFormedKeyRegister(tx)) {
        if (!isReplay) console.log(chalk.red('[LEDGER] Rejected KEY_REGISTER: malformed record.'));
        return false;
      }
      return true;
    }

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
      // The overspend floor (consensus step 4.3, 2026-10-17): FROM txrules.RULES_1_HEIGHT a deploy
      // whose creator cannot pay its fee is refused, like any other overspend. Below that height
      // the fee is still debited without a floor (old blocks must replay as they were mined), so
      // the caller says which applies: `floor` is set by datachain.js / api.js for rules-era
      // blocks only. Mirrored in Exe/core/state-db.js strictCheck (parity-tested).
      // THE TICKER BOOK, AND FROM RULES_2 THE FEE (Step 4, dex.js; as Exe/core/state-db.js): every
      // deploy is recorded (first one wins). From RULES_2 the ticker must be new and the fee is the
      // engine's; before it, the fee the transaction carries is charged as it always was.
      const rules2 = this._rules2(height);
      const dep = dex.applyDeploy(this.dex, tx, this._dexCtx(tx, height), { rules2 });
      if (!dep.ok) { console.log(chalk.red(`[LEDGER] Rejected TOKEN_DEPLOY: ${dep.why}`)); return false; }
      if (rules2) {
        for (const [payer, t, u, feeTo] of dep.fees) {
          this._setUnits(payer, t, -u);
          if (feeTo !== 'system') this._setUnits(feeTo, t, u);
        }
      } else {
        if (!isReplay && floor && !this._canPayDeployFees(creator, chain, meta)) {
          console.log(chalk.red('[LEDGER] Rejected TOKEN_DEPLOY: the creator cannot pay the deploy fee.'));
          return false;
        }
        this._applyDeployFees(creator, chain, meta);
      }
      this.dex = dep.book;

      if (chain === 'openchain') {
        // The supply goes to a hidden, network-held address — NOT the creator's wallet
        // (api.js:4082-4099). The address is carried in the transaction because it is
        // generated randomly at creation: regenerating it here would put the supply
        // somewhere new on every replay.
        const supplyTo = (rules2 && dep.supplyTo) || String(meta.supplyTo || '') ||
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
      // THE BOND GATE, EVALUATED AS OF THIS EPOCH — not as of now.
      //
      // `tx.verifierSet` is supplied by the caller that has the chain (datachain.js /
      // the miner), because State does not hold one. When absent the check degrades to
      // "distinct keys", which is the pre-bond behaviour: weaker, but it must still
      // validate, or every chain built before bonds existed would become unreplayable.
      //
      // ⚠️ HISTORICAL ON PURPOSE. Validating an old batch against TODAY's registry would
      // make a retired verifier's past signatures retroactively invalid, so a replay would
      // reach a different answer than the original run — a fork with no attacker involved.
      // See bonds.verifierSetAt.
      const quorum = verifyReceiptAttestations({
        epoch, receipts: list, attestations: tx.attestations,
        verifierSet: tx.verifierSet instanceof Set ? tx.verifierSet : null
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

    // VERIFIER_UNBOND / VERIFIER_RELEASE — the two halves of withdrawing a bond.
    //
    // ⚠️ WHY THESE ARE UP HERE BUT VERIFIER_BOND IS NOT. The split is deliberate and was
    // found the hard way: the ledger lock below rejects `amount <= 0`, and both of these
    // legitimately carry no amount. UNBOND only sets a timer; RELEASE returns a sum the
    // LEDGER already recorded (`bond.amount`), never a number the sender supplied. So there
    // is nothing for the overflow guard to check, and running them through it simply
    // rejected them.
    //
    // VERIFIER_BOND stays BELOW the lock, because it debits an attacker-supplied `amount`
    // and must face the same overflow and overdraft discipline as any transfer.
    if (String(type).toUpperCase() === 'VERIFIER_UNBOND') {
      const bond = this.bonds[from];
      if (!bond) {
        if (!isReplay) console.log(chalk.red('[LEDGER] Rejected VERIFIER_UNBOND: no bond.'));
        return false;
      }
      // The key stops counting as a verifier IMMEDIATELY (see bonds.verifierSetAt), but the
      // money stays at risk for the cooling-off window. Quitting must not be a way to
      // escape a judgement that is already in flight.
      bond.releasableAt = (Number(tx.height) || 0) + BOND_DEFAULTS.COOLING_OFF_BLOCKS;
      return true;
    }

    if (String(type).toUpperCase() === 'VERIFIER_RELEASE') {
      const bond = this.bonds[from];
      const allowed = canRelease({ bond, height: Number(tx.height) || 0 });
      if (!allowed.ok) {
        if (!isReplay) {
          console.log(chalk.red(`[LEDGER] Rejected VERIFIER_RELEASE: ${allowed.reason}` +
            (allowed.releasableAt ? ` (releasable at height ${allowed.releasableAt}, now ${allowed.height})` : '') + '.'));
        }
        return false;
      }
      // The SYR was never destroyed, only held out of the balances map. The amount comes
      // from the bond record, NOT from the transaction — so a forged `amount` field cannot
      // withdraw more than was put in.
      const sym = tx.tokenSymbol ? String(tx.tokenSymbol).toUpperCase() : 'SYR';
      if (!this.balances[sym]) this.balances[sym] = {};
      this.balances[sym][from] = fixDust((this.balances[sym][from] || 0) + (Number(bond.amount) || 0));
      delete this.bonds[from];
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

    // ── F6 SECURITY BONDS ──────────────────────────────────────────────────────
    // Below the ledger lock, unlike CHECKPOINT/NODE_ANNOUNCE/RECEIPT, because a bond MOVES
    // VALUE — it must go through the same overflow and overdraft discipline as a transfer,
    // not around it.
    //
    // The bond DEBITS the spendable balance rather than flagging it. Every "what can this
    // address spend" path is then correct with no changes, because the money is genuinely
    // not in the balances map. A lock that every future spend path must remember to
    // subtract is a lock that will eventually be forgotten.
    //
    // ⚠️ CONSENSUS NOTE: mirrored in Exe/core/state-db.js and pinned by
    // Exe/tests/state-parity.test.mjs. A node without these branches drops the transaction
    // and builds a different block — the 955-block lesson.
    if (type === 'VERIFIER_BOND') {
      const v = validateBond({ address: from, amount, verifierKey: tx.verifierKey });
      if (!v.ok) {
        if (!isReplay) console.log(chalk.red(`[LEDGER] Rejected VERIFIER_BOND: ${v.reason}.`));
        return false;
      }
      // Same overdraft rule as a transfer. A bond you cannot afford is not a bond.
      const bal = this.balances[tokenSymbol][from] || 0;
      if (!isReplay && bal < amount) {
        console.log(chalk.red('[LEDGER] Rejected VERIFIER_BOND: insufficient balance.'));
        return false;
      }
      this.balances[tokenSymbol][from] = fixDust(bal - amount);

      const prev = this.bonds[from];
      // Topping up ADDS rather than replaces, so strengthening a bond never leaves a gap
      // where the verifier is briefly unbonded. It also cancels a pending unbond.
      this.bonds[from] = {
        amount: fixDust((prev ? prev.amount : 0) + amount),
        verifierKey: tx.verifierKey,
        since: prev ? prev.since : (Number(tx.height) || 0),
        releasableAt: null
      };
      return true;
    }

    // ── ESCROW (consensus step 4.5, escrow.js) ──────────────────────────────────
    // Below the ledger lock: these move value. LOCK seller -> the keyless escrow address;
    // RELEASE escrow -> the buyer; REFUND escrow -> back to the seller. Which escrow, and whether
    // it may close, is judged by txrules.js against the escrow book; this only moves the coins,
    // refusing an overspend like a transfer. Mirrored in Exe/core/state-db.js (parity-tested).
    if (type === 'ESCROW_LOCK' || type === 'ESCROW_RELEASE' || type === 'ESCROW_REFUND') {
      const src = type === 'ESCROW_LOCK' ? from : ESCROW_ADDRESS;
      const dst = type === 'ESCROW_LOCK' ? ESCROW_ADDRESS : (type === 'ESCROW_RELEASE' ? to : from);
      const bal = this.balances[tokenSymbol][src] || 0;
      if (!isReplay && bal < amount) {
        console.log(chalk.red(`[LEDGER] Rejected ${type}: insufficient ${tokenSymbol}.`));
        return false;
      }
      this.balances[tokenSymbol][src] = fixDust(bal - amount);
      this.balances[tokenSymbol][dst] = fixDust((this.balances[tokenSymbol][dst] || 0) + amount);
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
        // Bonds hold real SYR that was debited from spendable balances. Losing them on a
        // restart would silently destroy that money — the balance is already gone from the
        // balances map, so nothing else remembers it exists.
        if (snap.bonds           && typeof snap.bonds === 'object')           this.bonds = snap.bonds;
        // The trading book (Step 4): open orders hold locked coins; like bonds, it must survive.
        if (snap.dex             && typeof snap.dex === 'object')             this.dex = dex.readBook(snap.dex);
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

        // The trading book (Step 4): one row, as the snapshot route serves it (dex_book).
        try {
            const dexRes = await pool.query('SELECT book FROM dex_book WHERE id = 1');
            if (dexRes.rows.length) this.dex = dex.readBook(dexRes.rows[0].book);
        } catch (dexErr) { /* no table yet: the book from the file (or a new one) stands */ }

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
        this.dex = dex.emptyBook();                // chain-derived: the replay below rebuilds it

        // ⚠️ `tokens`, `openTokens`, `openTokenSupply`, `epochReceipts` AND `bonds` ARE
        // DELIBERATELY NOT CLEARED.
        // Same invariant as Exe/core/state-db.js rebuildFromChain (:677-691), which is
        // explicit that no `DELETE FROM token_metadata` may ever be added there: tokens
        // that predate TOKEN_DEPLOY exist only in the snapshot, so clearing would erase
        // every one of them permanently on the next restart. Replay is idempotent without
        // clearing because each registry write is an assignment keyed on ticker, so
        // applying the same deploy twice is a no-op — the balances above are the only part
        // that ACCUMULATES, and those are the only part reset.

        try {
            const allTxs = await pool.query("SELECT * FROM transactions ORDER BY block_index ASC, timestamp_ms ASC, id ASC");
            let atBlock = null;
            for (const row of allTxs.rows) {
                // Step 4.4: a block's one-time corrections come before its first transaction.
                if (row.block_index !== atBlock) { atBlock = row.block_index; this.applyCorrections(Number(atBlock)); }
                // The transaction exactly as mined (tx_json, step 4.3) when stored: a trading record
                // rebuilt from columns alone would have lost its side, price, deadline and keys.
                let tx = null;
                if (typeof row.tx_json === 'string' && row.tx_json) { try { tx = JSON.parse(row.tx_json); } catch (e) { tx = null; } }
                if (!tx || typeof tx !== 'object') tx = {
                    from: row.from_address, to: row.to_address, amount: parseFloat(row.amount),
                    amountUsd: parseFloat(row.amount_usd), type: row.type, tokenSymbol: row.token_symbol,
                    priceUsd: parseFloat(row.price_usd)
                };
                this.applyTransaction(tx, 0, true, { height: Number(row.block_index) });
            }
        } catch(dbErr) {
             console.log(chalk.red("[STATE] DB Replay failed. Attempting memory object fallback..."));
             for (let i = 0; i < chain.length; i++) {
                const block = chain[i];
                this.applyCorrections(block.index);          // step 4.4
                if (typeof block.data === 'string') continue;
                for (const tx of block.data) this.applyTransaction(tx, 0, true, { height: block.index });
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
              // F6 security bonds. MUST be persisted: the SYR has already been debited from
              // the balances map, so this record is the only thing that knows it is owed back.
              bonds: this.bonds,
              // The trading book (Step 4): open orders hold locked coins, markets hold reserves.
              dex: this.dex,
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
          // The trading book (Step 4), one row: what api.js's snapshot route serves as `dex_book`.
          await client.query('CREATE TABLE IF NOT EXISTS dex_book (id INT PRIMARY KEY, book TEXT NOT NULL)');
          await client.query('INSERT INTO dex_book (id, book) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET book = $1', [JSON.stringify(this.dex)]);
          
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
