// ════════════════════════════════════════════════════════════════════════════════
// txrules.js — which transactions a block may carry, from RULES_1_HEIGHT on
//              (consensus validation, sub-step 4.1; 09/R115, R116; owner 2026-10-17)
//
// ⚠️ CONSENSUS CODE IN TWO COPIES. Exe/core/txrules.js is the CommonJS twin of this file.
// A block one copy accepts and the other refuses is a FORK. Exe/tests/module-parity.test.mjs
// drives both copies with identical inputs. Change both or neither.
//
// WHY. Until now a block was checked only for its link, proof of work and hash. Nothing asked
// whether a transaction was signed, whether the signing key OWNS the `from` address, whether
// the coinbase paid exactly 2 + 13 SYR, or whether the same signed transaction had already
// been mined. A peer could feed a block that spent anyone's coins (09/R115). Nodes guarded
// themselves with LOCAL policy only (Exe/core/tx-auth.js on what their own miner includes).
//
// WHAT THIS FILE IS. STATELESS rules: everything that can be decided from the block, the
// transaction and two lookups the caller supplies (ids already mined; the key registry).
// Balances are checked where they live — the ledger refuses an overspend (state.js) — and
// who may appoint whom is decided in the role registry (gov-registry.js). This file does not
// wire itself in anywhere: each node calls checkBlock() on every path that accepts a block.
//
// ACTIVATION. Blocks below RULES_1_HEIGHT are judged by the old rules, so history stays valid
// (#358-#1080 hold only the 2 + 13 coinbase; #348-#357 are Railway-era). Owner's choice
// 2026-10-17: block 1,200.
//
// FROM RULES_1_HEIGHT ON, A BLOCK IS VALID ONLY IF:
//   1. data[0] is the miner reward  (system -> miner,             2 SYR, TRANSFER) and
//      data[1] is the treasury share (system -> nexus-ai-treasury, 13 SYR, TRANSFER);
//   2. no other system transaction appears, except the miner's state-root CHECKPOINT on its
//      720-block cadence (Exe miner, settings.commitStateRoot). Epoch settlement is DORMANT
//      (epoch.js EPOCH_1_HEIGHT): before it is activated, this file must learn to check the
//      settlement batch, or every settlement block will be refused — refused, not trusted;
//   3. every other transaction is of an allowed type, signed, its signature genuine, and its
//      signing key OWNS `from` — by derivation (nx_/nd_ + sha256(PEM)[0:40], 160 bits) or
//      through the on-chain key registry (sub-step 4.2). Weak address forms (website nx_ +
//      39 base64 characters, legacy 42-character raw keys) keep only 3 / 6 characters of key
//      and are never accepted by derivation (09/R116);
//   4. amounts are real numbers of the right sign, and the timestamp is not in the future;
//   5. no signed transaction appears twice — in this block or in any earlier block;
//   6. a KEY_REGISTER (sub-step 4.2, key-record.js) carries the key holder's AND the owner's
//      signature, binds a weak address its key produces, and that address is not registered
//      yet — not before this block, not earlier in it. A spend may use a registration from
//      the NEXT block on (keyFor describes the chain before this block).
//
// REFUSED FROM RULES_1_HEIGHT (owner 2026-10-17): USD_DEPOSIT, USD_WITHDRAWAL, MINT, BUY / SELL
// against `system`, MARKET_TRADE — each needed the Railway server to vouch for money that
// moved off-chain; with no such server anyone could sign one crediting themselves. Deposits
// and withdrawals become peer trades with on-chain escrow (DATACHAIN_PAYMENTS_BYO_CONNECTOR §4,
// sub-step 4.5). LIQUIDITY_WITHDRAW is refused for the same reason (it spends a USD balance).
//
// FROM RULES_2_HEIGHT (on-chain trading, seven-phase plan Step 4; DORMANT until the owner confirms
// the height): the trading types of dex.js are allowed — their SHAPE is checked here; who may sign
// them and whether the funds suffice are the ledger's, through the same engine in both nodes. A
// TOKEN_DEPLOY needs a well-formed ticker and says the most it will pay (dex.deployShapeWhy; a taken
// ticker is refused by the ledger's book). LIQUIDITY_INIT / LIQUIDITY_DEPOSIT are refused.
// ════════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { canonicalSpki, strongAddressOf, isWellFormedGovRole, signedBytes } from './gov-record.js';
import { checkKeyRegister, registerBody, buildKeyRegistry } from './key-record.js';
import { ESCROW_ADDRESS, ESCROW_TYPES, escrowShapeWhy, closeWhy, escrowBook } from './escrow.js';
import { DEX, DEX_TYPES, dexShapeWhy, deployShapeWhy } from './dex.js';

// Activation height (owner 2026-10-17). Below it, checkBlock() says yes to everything.
export const RULES_1_HEIGHT = 1200;

// ON-CHAIN TRADING (seven-phase plan Step 4, dex.js): the trading types, the RULES_2 deploy rules
// and the end of LIQUIDITY_INIT / LIQUIDITY_DEPOSIT. DORMANT: a sentinel until the owner confirms
// the height (Step 6) — at least 2,000 blocks above the chain then, after node1 and every exe run
// this build. Tests switch it on through ctx.params.RULES_2_HEIGHT (and the ledgers' rules2Height).
export const RULES_2_HEIGHT = Number.MAX_SAFE_INTEGER;

export const RULES_DEFAULTS = {
    MINER_REWARD: 2,                       // datachain.js / Exe chain.js: flat 2 SYR to the miner
    TREASURY_REWARD: 13,                   // … and 13 SYR to the keyless AI treasury (F23)
    TREASURY_ADDRESS: 'nexus-ai-treasury',
    STATE_ROOT_BLOCKS: 720,                // Exe miner.js STATE_ROOT_BLOCKS
    MAX_BLOCK_TXS: 100,                    // coinbase 2 + state root 1 + the miner's 50, with room
    MAX_TX_BYTES: 262144,                  // a TOKEN_DEPLOY may carry a 200,000-character logo
    MAX_FUTURE_MS: 2 * 60 * 60 * 1000,     // a transaction may not be dated after its block + 2 h
    RULES_2_HEIGHT                         // on-chain trading (above); overridable in tests only
};

// Addresses nobody holds a key for. Nothing may be SPENT from them by a signed transaction.
export const KEYLESS = ['system', 'NETWORK', 'nexus-ai-treasury', 'liquidity-pool', ESCROW_ADDRESS, DEX.POOL, DEX.ORDERS];

// The user transaction types a block may carry, and how their amount must look:
//   value  - a real number > 0         supply - a real number >= 0         zero - 0 or absent
export const USER_TYPES = {
    TRANSFER: 'value',
    TOKEN_DEPLOY: 'supply',
    LIQUIDITY_INIT: 'value',
    LIQUIDITY_DEPOSIT: 'value',
    VERIFIER_BOND: 'value',
    ESCROW_LOCK: 'value',          // step 4.5 (escrow.js): seller's coins -> the escrow address
    ESCROW_RELEASE: 'value',       //   escrow -> the buyer, signed by the seller
    ESCROW_REFUND: 'value',        //   escrow -> back to the seller, from the deadline
    NODE_ANNOUNCE: 'zero',
    GOV_ROLE: 'zero',
    KEY_REGISTER: 'zero',
    VERIFIER_UNBOND: 'zero',
    VERIFIER_RELEASE: 'zero',
    // On-chain trading, from RULES_2_HEIGHT (dex.js). Who may sign them is the ledger's to judge.
    SWAP: 'value',                 // amount = what is paid in (SDTX for a buy, the token for a sell)
    ORDER_PLACE: 'value',          // amount = how many tokens
    ORDER_CANCEL: 'zero',
    POOL_CREATE: 'value',          // amount = the tokens seeded
    POOL_ADD: 'supply',            // amount = tokens added (0 when adding only SDTX)
    SDTX_ISSUE: 'value',
    SDTX_BURN: 'value',
    ISSUER_SET: 'zero',
    ISSUER_REVOKE: 'zero',
    NETWORK_FEE_SET: 'zero'
};

// ── ONE-TIME LEDGER CORRECTIONS (consensus step 4.4) ─────────────────────────────────
// Publicly recorded state changes that happen when a given block is applied, BEFORE its
// transactions, identically in both ledgers (and on every replay). Owner's 18B decision D1
// (2026-10-16, DATACHAIN_18B_LEDGER.txt sec. 8): retire the frozen ~6B SYR row of `system`, the
// keyless mint authority — it was never spendable (nobody holds its key, the ledger never debits
// it), it only made "sum of all balances" read ~6B more than the real supply. Mining still works:
// `system` mints the coinbase from nothing in both ledgers.
export const LEDGER_CORRECTIONS = [
    { height: RULES_1_HEIGHT, address: 'system', token: 'SYR', setTo: 0,
      reason: 'D1: retire the frozen ~6B SYR mint-authority row (DATACHAIN_18B_LEDGER.txt sec. 8)' }
];

/** The corrections to apply when block `height` is applied (before its transactions). */
export function correctionsAt(height) {
    const h = Number(height);
    return LEDGER_CORRECTIONS.filter(c => c.height === h);
}

// Named here so a refusal can say WHY; anything not in USER_TYPES is refused anyway.
export const REFUSED_TYPES = ['USD_DEPOSIT', 'USD_WITHDRAWAL', 'MINT', 'BUY', 'SELL', 'MARKET_TRADE', 'LIQUIDITY_WITHDRAW'];

const COINBASE_KEYS = ['from', 'to', 'amount', 'type', 'tokenSymbol', 'timestamp', 'isSystemGenerated', 'description'];
// Blocks that went through the primary's Postgres `transactions` table come back with these
// columns filled EMPTY (node1 #384-#423). Tolerated on the coinbase only, and only empty.
const DB_EMPTY_COLUMNS = { amountUsd: 0, signature: '', publicKey: '', platformType: '' };
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isStr = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max;
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function rulesActive(height) {
    const h = Number(height);
    return Number.isFinite(h) && h >= RULES_1_HEIGHT;
}

/** Is on-chain trading (RULES_2) active at this height? `params` is ctx.params (tests only). */
export function rules2Active(height, params = null) {
    const h = Number(height);
    const at = params && Number.isSafeInteger(params.RULES_2_HEIGHT) ? params.RULES_2_HEIGHT : RULES_2_HEIGHT;
    return Number.isFinite(h) && h >= at;
}

/**
 * A transaction's identity for replay protection: sha256 of the bytes its signature covers.
 * NOT the signature itself — an ECDSA signature (r, s) has a twin (r, n - s) that verifies the
 * same bytes, so a "new" signature string could replay an old transfer.
 */
export function txId(tx) {
    // A registration carries two signatures over registerBody(); its identity is that body.
    return sha256hex(tx && tx.type === 'KEY_REGISTER' ? registerBody(tx) : signedBytes(tx));
}

// A WebCrypto signature is raw r||s (128 hex characters); Node verifies DER.
function rawToDer(rawSigHex) {
    const strict = (hex) => {
        while (hex.length > 2 && hex.startsWith('00')) hex = hex.substring(2);
        if (parseInt(hex.substring(0, 2), 16) >= 128) hex = '00' + hex;
        return hex;
    };
    const r = strict(rawSigHex.substring(0, 64));
    const s = strict(rawSigHex.substring(64, 128));
    const seq = '02' + (r.length / 2).toString(16).padStart(2, '0') + r + '02' + (s.length / 2).toString(16).padStart(2, '0') + s;
    return '30' + (seq.length / 2).toString(16).padStart(2, '0') + seq;
}

/** Is tx.signature a genuine signature by tx.publicKey (PEM or base64 SPKI) over its signed bytes? */
export function verifySignature(tx) {
    if (!tx || typeof tx.signature !== 'string' || !/^[0-9a-fA-F]{16,300}$/.test(tx.signature)) return false;
    const spki = canonicalSpki(tx.publicKey);
    if (!spki) return false;
    try {
        const key = crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
        const sig = tx.signature.length === 128 ? rawToDer(tx.signature) : tx.signature;
        const v = crypto.createVerify('SHA256');
        v.update(signedBytes(tx));
        return v.verify(key, sig, 'hex');
    } catch (e) {
        return false;
    }
}

/**
 * Does the signing key own `from`? 'strong' (derivation, 160 bits), 'registry' (the key
 * registry binds this address to exactly this key), or null.
 * @param {(address:string) => (string|null)} [keyFor]  registered base64 SPKI for an address
 */
export function ownsFrom(tx, keyFor = null) {
    if (!tx || typeof tx.from !== 'string') return null;
    const from = tx.from;
    const spki = canonicalSpki(tx.publicKey);
    if (!spki) return null;
    // The PEM exactly as the signer carried it (how wallets derive their address) …
    if (typeof tx.publicKey === 'string' && tx.publicKey.includes('BEGIN PUBLIC KEY')) {
        const h = sha256hex(tx.publicKey).substring(0, 40);
        if (from === 'nx_' + h || from === 'nd_' + h) return 'strong';
    }
    // … or its canonical spelling, so a re-wrapped PEM still matches its own address.
    const strong = strongAddressOf(spki);
    if (strong && (from === strong || from === 'nd_' + strong.substring(3))) return 'strong';
    if (typeof keyFor === 'function') {
        let bound = null;
        try { bound = keyFor(from); } catch (e) { bound = null; }
        if (bound && bound === spki) return 'registry';
    }
    return null;
}

function coinbaseWhy(tx, which, p) {
    if (!tx || typeof tx !== 'object') return which + ' is missing';
    const want = which === 'miner reward' ? p.MINER_REWARD : p.TREASURY_REWARD;
    if (tx.from !== 'system' || tx.type !== 'TRANSFER' || tx.tokenSymbol !== 'SYR' || tx.isSystemGenerated !== true) {
        return which + ' must be a system SYR TRANSFER';
    }
    if (tx.amount !== want) return `${which} must be exactly ${want} SYR`;
    if (!isNum(tx.timestamp)) return which + ' has no timestamp';
    if (Object.keys(tx).some(k => !COINBASE_KEYS.includes(k) && !(k in DB_EMPTY_COLUMNS && tx[k] === DB_EMPTY_COLUMNS[k]))) {
        return which + ' carries unexpected fields';
    }
    if (tx.description !== undefined && !(typeof tx.description === 'string' && tx.description.length <= 200)) return which + ' has a malformed description';
    if (which === 'treasury share') {
        if (tx.to !== p.TREASURY_ADDRESS) return 'the treasury share must go to ' + p.TREASURY_ADDRESS;
    } else if (!isStr(tx.to, 128) || KEYLESS.includes(tx.to)) {
        return 'the miner reward must go to a real address';
    }
    return null;
}

const isSystemTx = (tx) => !!tx && (tx.isSystemGenerated === true || KEYLESS.includes(tx.from));

// The address a NODE_ANNOUNCE may publish — exactly what state.js accepts (an https origin with
// nothing after it, at most 200 characters), or '' to retire. Checked here so a block carrying
// one state.js would refuse is refused by every node, not accepted by some.
function isServableUrl(url) {
    if (typeof url !== 'string') return false;
    const u = url.trim();
    if (u === '') return true;
    if (u.length > 200) return false;
    let p;
    try { p = new URL(u); } catch (e) { return false; }
    return p.protocol === 'https:' && !p.username && !p.password && !p.search && !p.hash && p.pathname === '/';
}

// The Exe miner's ledger fingerprint (miner.js _stateRootCommitment): on its cadence only,
// describing the PREVIOUS height. Whether the root is RIGHT is for the ledger to check.
function isStateRootCheckpoint(tx, height, p) {
    return !!tx && height % p.STATE_ROOT_BLOCKS === 0 && tx.type === 'CHECKPOINT' && tx.isSystemGenerated === true
        && tx.from === p.TREASURY_ADDRESS && tx.to === p.TREASURY_ADDRESS && tx.amount === 0 && tx.tokenSymbol === 'SYR'
        && typeof tx.snapshotRoot === 'string' && /^[0-9a-f]{64}$/.test(tx.snapshotRoot)
        && tx.root === null && tx.checkpointRoot === null && tx.pendingRoot === null
        && tx.height === height - 1 && isNum(tx.timestamp);
}

/**
 * Why this user transaction may not be in a block at this height (null = it may).
 * Stateless: replay and balance are checked by the caller / the ledger.
 */
export function checkUserTx(tx, block, ctx = {}) {
    const p = Object.assign({}, RULES_DEFAULTS, ctx.params || {});
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return 'not a transaction';
    let size = 0;
    try { size = JSON.stringify(tx).length; } catch (e) { return 'not serialisable'; }
    if (size > p.MAX_TX_BYTES) return 'too large';
    const type = tx.type;
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(USER_TYPES, type)) {
        return REFUSED_TYPES.includes(String(type).toUpperCase())
            ? `${String(type).toUpperCase()} is no longer valid (it needed the Railway server to vouch for it)`
            : 'transaction type not allowed: ' + String(type).slice(0, 32);
    }
    if (tx.isSystemGenerated) return 'a signed transaction cannot claim to be system-generated';
    if (!isStr(tx.from, 128)) return 'missing "from"';
    if (KEYLESS.includes(tx.from)) return 'nothing can be spent from ' + tx.from;
    if (!isStr(tx.to, 200)) return 'missing "to"';
    if (!isNum(tx.timestamp) || tx.timestamp <= 0) return 'missing timestamp';
    if (block && isNum(block.timestamp) && tx.timestamp > block.timestamp + p.MAX_FUTURE_MS) return 'dated in the future';

    const height = block && Number.isFinite(Number(block.index)) ? Number(block.index) : null;
    const kind = USER_TYPES[type];
    if (kind === 'value' && !(isNum(tx.amount) && tx.amount > 0)) return 'the amount must be a number above 0';
    if (kind === 'supply' && !(isNum(tx.amount) && tx.amount >= 0)) return 'the supply must be a number of 0 or more';
    if (kind === 'zero' && !(tx.amount === undefined || tx.amount === 0)) return 'this type moves nothing; its amount must be 0';
    // UPPER-CASE only: state.js upper-cases a symbol and the exe's state-db.js does not, so a
    // mixed-case symbol would land on two different balance rows in the two ledgers.
    if (tx.tokenSymbol !== undefined && !(typeof tx.tokenSymbol === 'string' && /^[A-Z0-9]{1,20}$/.test(tx.tokenSymbol))) {
        return 'malformed token symbol (upper-case letters and digits)';
    }
    // On-chain trading (dex.js), from RULES_2_HEIGHT only; a height the caller does not know is refused.
    if (DEX_TYPES.includes(type)) {
        if (height === null || !rules2Active(height, p)) {
            return p.RULES_2_HEIGHT >= Number.MAX_SAFE_INTEGER ? 'on-chain trading is not switched on yet' : type + ' is valid only from block ' + p.RULES_2_HEIGHT;
        }
        const shape = dexShapeWhy(tx);
        if (shape) return shape;
    }
    if (height !== null && rules2Active(height, p)) {
        // LIQUIDITY_INIT could mint pool reserves from nothing and reset a pool; the markets are
        // POOL_CREATE / POOL_ADD now. A deploy needs a new, well-formed ticker and says its fee limit.
        if (type === 'LIQUIDITY_INIT' || type === 'LIQUIDITY_DEPOSIT') return type + ' is no longer valid (markets are POOL_CREATE / POOL_ADD)';
        // The market addresses move only through the engine: a coin sent there by hand would sit outside
        // the book (lost to its sender, and the pool's address no longer equal to its reserves).
        if (tx.to === DEX.POOL || tx.to === DEX.ORDERS) return 'nothing can be sent to ' + tx.to + ' (it holds the markets)';
        if (type === 'TOKEN_DEPLOY') {
            const shape = deployShapeWhy(tx);
            if (shape) return shape;
        }
    }
    if (type === 'LIQUIDITY_INIT') {
        if (tx.to !== 'liquidity-pool') return 'liquidity goes to liquidity-pool';
        if (!(isNum(tx.amountUsd) && tx.amountUsd >= 0)) return 'malformed USD amount';
    }
    if (type === 'NODE_ANNOUNCE') {
        if (tx.to !== tx.from) return 'an announcement is addressed to itself';
        if (!isServableUrl(tx.url)) return 'malformed announcement address (https origin only, or empty to retire)';
    }
    if (type === 'GOV_ROLE' && !isWellFormedGovRole(tx)) return 'malformed role record';
    // Escrow (step 4.5): from RULES_1_HEIGHT only; a close must match an OPEN escrow in the book
    // (ctx.escrowOf — the chain before this block). The seller signs all three: checked below.
    if (ESCROW_TYPES.includes(type)) {
        if (height !== null && !rulesActive(height)) return `escrow is valid only from block ${RULES_1_HEIGHT}`;
        const shape = escrowShapeWhy(tx, height);
        if (shape) return shape;
        if (type !== 'ESCROW_LOCK') {
            const rec = typeof ctx.escrowOf === 'function' ? ctx.escrowOf(tx.escrowId) : null;
            const why = closeWhy(tx, rec, height);
            if (why) return why;
        }
    }
    // Two signatures over registerBody(), not one over signedBytes(): its own check, complete.
    if (type === 'KEY_REGISTER') return checkKeyRegister(tx, { keyFor: ctx.keyFor, ownerKey: ctx.ownerKey });

    if (!verifySignature(tx)) return 'unsigned, or the signature is not genuine';
    if (!ownsFrom(tx, ctx.keyFor)) return 'the signing key does not own "from" (needs a strong address or a registered key)';
    return null;
}

/**
 * Every rule a block must pass at its height. Call it on EVERY path that accepts a block.
 * @param {object} block  { index, timestamp, data: [...] }
 * @param {object} [ctx]
 * @param {(id:string) => boolean} [ctx.seen]    true if txId(tx) is already in an EARLIER block
 * @param {(address:string) => (string|null)} [ctx.keyFor]  the key registry (sub-step 4.2)
 * @param {object} [ctx.params]                   overrides of RULES_DEFAULTS (tests)
 * @returns {{ok:boolean, active:boolean, errors:Array<{index:number, why:string}>}}
 */
export function checkBlock(block, ctx = {}) {
    if (!block || !rulesActive(block.index)) return { ok: true, active: false, errors: [] };
    const p = Object.assign({}, RULES_DEFAULTS, ctx.params || {});
    const errors = [];
    const fail = (index, why) => errors.push({ index, why });
    const data = block.data;
    if (!Array.isArray(data)) { fail(-1, 'block data is not a list of transactions'); return { ok: false, active: true, errors }; }
    if (data.length > p.MAX_BLOCK_TXS) fail(-1, `too many transactions (${data.length} > ${p.MAX_BLOCK_TXS})`);

    const m = coinbaseWhy(data[0], 'miner reward', p);
    if (m) fail(0, m);
    const t = coinbaseWhy(data[1], 'treasury share', p);
    if (t) fail(1, t);

    const ids = new Set();
    const registered = new Set();
    const closed = new Set();
    let stateRoots = 0;
    for (let i = 2; i < data.length; i++) {
        const tx = data[i];
        if (isSystemTx(tx)) {
            if (isStateRootCheckpoint(tx, block.index, p) && stateRoots === 0) { stateRoots++; continue; }
            fail(i, 'no system transaction is allowed here (only the coinbase and the state root on its cadence)');
            continue;
        }
        const why = checkUserTx(tx, block, Object.assign({}, ctx, { params: p }));
        if (why) { fail(i, why); continue; }
        const id = txId(tx);
        if (ids.has(id)) { fail(i, 'the same transaction appears twice in this block'); continue; }
        let old = false;
        try { old = typeof ctx.seen === 'function' && !!ctx.seen(id); } catch (e) { old = false; }
        if (old) { fail(i, 'already mined in an earlier block (replay)'); continue; }
        if (tx.type === 'KEY_REGISTER') {
            if (registered.has(tx.from)) { fail(i, 'this address is registered twice in this block'); continue; }
            registered.add(tx.from);
        }
        if (tx.type === 'ESCROW_RELEASE' || tx.type === 'ESCROW_REFUND') {
            if (closed.has(tx.escrowId)) { fail(i, 'this escrow is closed twice in this block'); continue; }
            closed.add(tx.escrowId);
        }
        ids.add(id);
    }
    return { ok: errors.length === 0, active: true, errors };
}

/**
 * What checkBlock needs to know about the chain BEFORE a block — the ids already mined and the
 * key registry — kept up to date as blocks are accepted one by one (sync, a competing branch).
 * Both nodes build it the same way. Blocks whose data is not a list (a primary that offloaded
 * old block bodies to its database) contribute nothing; give it their transactions instead.
 * @param {Array} [blocks]  the chain so far, oldest first
 */
export function ruleIndex(blocks = [], { ownerKey } = {}) {
    const ids = new Set();
    const regBlocks = [];
    let registry = null;
    const escrows = escrowBook([], { fromHeight: RULES_1_HEIGHT });       // step 4.5
    const index = {
        add(block) {
            if (!block || !Array.isArray(block.data)) return index;
            escrows.add(block);
            const regs = [];
            for (const tx of block.data) {
                if (!tx || typeof tx !== 'object' || isSystemTx(tx)) continue;
                if (typeof tx.signature === 'string') ids.add(txId(tx));
                if (tx.type === 'KEY_REGISTER') regs.push(tx);
            }
            if (regs.length) { regBlocks.push({ index: block.index, timestamp: block.timestamp, data: regs }); registry = null; }
            return index;
        },
        ctx() {
            if (!registry) registry = buildKeyRegistry(regBlocks, ownerKey === undefined ? {} : { ownerKey });
            return { seen: (id) => ids.has(id), keyFor: registry.keyFor, ownerKey, escrowOf: escrows.get };
        },
        escrows: () => escrows.list(),
        size: () => ids.size
    };
    for (const b of Array.isArray(blocks) ? blocks : []) index.add(b);
    return index;
}

/**
 * The ids of every signed, non-system transaction in these blocks, for checkBlock's `seen`.
 * Taken from ALL heights: a transfer mined before activation must not be replayable after it.
 */
export function collectTxIds(blocks) {
    const out = new Set();
    for (const b of Array.isArray(blocks) ? blocks : []) {
        for (const tx of (b && Array.isArray(b.data)) ? b.data : []) {
            if (tx && typeof tx === 'object' && !isSystemTx(tx) && typeof tx.signature === 'string') out.add(txId(tx));
        }
    }
    return out;
}
