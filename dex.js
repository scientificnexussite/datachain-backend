// ════════════════════════════════════════════════════════════════════════════════
// dex.js — ON-CHAIN TRADING (seven-phase plan, Step 4, 2026-10-18; valid from RULES_2_HEIGHT):
//          one AMM pool per token priced in SDTX, limit orders that fill against it, SDTX issued
//          by the owner (or an issuer key the owner appoints), and the deploy fees and ticker book.
//
// ⚠️ CONSENSUS CODE IN TWO COPIES. Exe/core/dex.js is the CommonJS twin of this file. Both
// ledgers (DataChain_Core/state.js, Exe/core/state-db.js) keep the SAME book and hand every
// trading transaction to applyDexTx(); a different result in one of them is a FORK.
// Exe/tests/module-parity.test.mjs drives both copies. Change both or neither.
//
// ONE PURE ENGINE. The book is a plain JSON object. applyDexTx(book, tx, ctx) never mutates what
// it is given: it returns the NEW book, the balance changes (deltas, in order) and the trades
// (events). Each ledger applies the deltas the same way (applyUnits) and stores the book its own
// way. Nothing here reads a clock, a random number, a float price or a database.
//
// NUMBERS. Every amount is an integer count of 1e-8 units (BigInt in memory, a decimal STRING in
// the book); prices are SDTX per token scaled by 1e18. Square roots are avoided altogether: "up to
// the limit price" is an exact integer comparison inside a binary search. A block gives the same
// result on every machine.
//
// THE POOL (constant product, x·y = k). X = the pool's REAL SDTX plus its VIRTUAL cushion (set at
// creation, never paid out), Y = its tokens. The 0.30% fee is taken on the input, rounded UP; the
// output is rounded DOWN; the whole input (fee included) stays in the pool, so k never decreases —
// checked after every trade. A sell can only ever be paid in REAL SDTX.
//
// ORDERS. ORDER_PLACE locks the funds (SDTX for a buy, the token for a sell) at nexus-dex-orders.
// Orders fill AGAINST THE POOL, inside the transaction that moved the price (a swap, a new order,
// liquidity added): best price first, then oldest, each up to its limit price (no unit fills worse
// than the limit), at most MAX_FILLS_PER_TX fills per transaction. There is no hidden end-of-block
// step. An order lives through block `expiry`; an expired order is refunded the next time its
// token is traded, or by ORDER_CANCEL at any time.
//
// WHO MAY:
//   POOL_CREATE / POOL_ADD   the token's creator (the ticker book: deploys from the blocks + the
//                            frozen LEGACY_TOKENS list); SYR: the owner key only. The creator may
//                            route a token's stranded supply (a legacy nx_sys_/nx_open_ address, an
//                            OpenChain supply address) into its pool with `source`.
//   SDTX_ISSUE / SDTX_BURN   the owner key, or an issuer key the owner appointed (ISSUER_SET), an
//                            issuer within its cap per ISSUER_WINDOW blocks; every `ref` once.
//   ISSUER_SET / _REVOKE     the owner key.
//   NETWORK_FEE_SET          the token's creator: the SYR fee an OpenChain coin deployed under it pays.
// ════════════════════════════════════════════════════════════════════════════════

import { canonicalSpki } from './gov-record.js';
import { ESCROW_ADDRESS } from './escrow.js';

export const DEX = Object.freeze({
    POOL: 'nexus-dex-pool',                 // keyless: every pool's real reserves
    ORDERS: 'nexus-dex-orders',             // keyless: funds locked by open orders
    FEE_BPS: 30,                            // 0.30%, kept in the pool
    VIRTUAL_CAP: 10000,                     // SDTX of virtual cushion a DelChain/OpenChain market may have
    MAX_ORDERS_PER_ADDRESS: 50,
    MAX_ORDERS_PER_TOKEN: 2000,
    MAX_FILLS_PER_TX: 64,
    MAX_EXPIRY_BLOCKS: 259200,              // ~30 days at 8,640 blocks a day
    DUST_UNITS: 100,                        // 0.000001 of a coin: a remainder this small closes the order
    ISSUER_WINDOW: 8640,                    // an issuer's cap counts the last 8,640 blocks (~a day)
    DELCHAIN_FEE_SDTX: 1,                   // $1.00 in SYR at the SYR market's price …
    DELCHAIN_FALLBACK_FEE_SYR: 2,           // … or this many SYR until the SYR market exists
    OPENCHAIN_FEE_SDTX: 1,                  // 1 SDTX, destroyed
    MAX_AMOUNT: 1e15,
    MAX_PRICE: 1e12
});

export const DEX_TYPES = Object.freeze(['SWAP', 'ORDER_PLACE', 'ORDER_CANCEL', 'POOL_CREATE', 'POOL_ADD',
    'SDTX_ISSUE', 'SDTX_BURN', 'ISSUER_SET', 'ISSUER_REVOKE', 'NETWORK_FEE_SET']);

// A ticker is permanent and global (the deploy routes' own preflight); these can never be deployed.
export const TICKER_RE = /^[A-Z][A-Z0-9]{1,11}$/;
export const RESERVED_TICKERS = Object.freeze(['SYR', 'USD', 'SDTX', 'SDX']);

// Coins that exist without a TOKEN_DEPLOY in the blocks (the Step 0 census, 2026-10-17, owner's
// review: GAMECASH and NEXUSCASH belong to the owner's main wallet). `sources` are the keyless
// addresses holding their stranded supply, which only the creator may route into the coin's pool.
// FROZEN CONSENSUS DATA: a mistake here is permanent once RULES_2 is live.
const OWNER_MAIN = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5z7IyY';
export const LEGACY_TOKENS = Object.freeze([
    Object.freeze({ ticker: 'GAMECASH', chain: 'delchain', creator: OWNER_MAIN, sources: Object.freeze(['nx_sys_191a09a064ff1b7102934cf5eba281ec']) }),
    Object.freeze({ ticker: 'NEXUSCASH', chain: 'delchain', creator: OWNER_MAIN, sources: Object.freeze(['nx_sys_a937b2ea75a710631f78d2afa87c3af0']) }),
    Object.freeze({ ticker: 'MARIO', chain: 'openchain', creator: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcZsKwt', sources: Object.freeze(['nx_open_4fff6c996b30d350b157e51dbc586cd7']) }),
    Object.freeze({ ticker: 'BORAXI', chain: 'openchain', creator: 'nx_MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEp7s', sources: Object.freeze(['nx_open_eae406399ff163dc97ce02f94d7458ec']) }),
    Object.freeze({ ticker: 'LEXCASH', chain: 'openchain', creator: OWNER_MAIN, sources: Object.freeze(['nx_open_e978d859db39aef2c50f3fed6dd1041c']) }),
    Object.freeze({ ticker: 'TESTMOVE', chain: 'openchain', creator: OWNER_MAIN, sources: Object.freeze(['nx_open_8dd72032e745e15a8aba45ae9978e583']) })
]);

// Addresses that may never RECEIVE issued SDTX (nobody could ever spend it).
const NOT_RECIPIENTS = ['system', 'NETWORK', 'nexus-ai-treasury', 'liquidity-pool', ESCROW_ADDRESS, DEX.POOL, DEX.ORDERS];

const E8 = 100000000n;
const E18 = 1000000000000000000n;
const FEE_N = BigInt(DEX.FEE_BPS);
const FEE_D = 10000n;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isInt = (x) => Number.isSafeInteger(x);

// ── units ───────────────────────────────────────────────────────────────────────────

/** A coin amount (number) as an integer count of 1e-8 units. Throws on NaN / out of range. */
export function toUnits(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) throw new Error('not a number');
    const s = Math.abs(n).toFixed(8);
    if (s.includes('e')) throw new Error('out of range');
    const [w, f] = s.split('.');
    const u = BigInt(w) * E8 + BigInt(f);
    return n < 0 ? -u : u;
}

/** Units back to the nearest number — exactly the value a ledger rounding to 8 decimals holds. */
export function fromUnits(u) {
    const v = BigInt(u);
    const a = v < 0n ? -v : v;
    return Number((v < 0n ? '-' : '') + (a / E8).toString() + '.' + (a % E8).toString().padStart(8, '0'));
}

/** A ledger balance after a change of `delta` units: how BOTH ledgers apply a trading delta. */
export function applyUnits(current, delta) {
    return fromUnits(toUnits(Number(current) || 0) + BigInt(delta));
}

/** A price (SDTX per token, a number) scaled by 1e18, from 12 decimals. 0n when unusable. */
export function priceE18(p) {
    if (!isNum(p) || p <= 0 || p > DEX.MAX_PRICE) return 0n;
    const [w, f] = p.toFixed(12).split('.');
    return (BigInt(w) * 1000000000000n + BigInt(f)) * 1000000n;
}

const units = (x) => BigInt(x || 0);
const ceilDiv = (a, b) => (a + b - 1n) / b;
const netOf = (g) => g - ceilDiv(g * FEE_N, FEE_D);

// ── shapes (stateless; txrules.js calls these from RULES_2_HEIGHT) ────────────────────

/** A positive amount the ledger can hold (≥ 1 unit, at most MAX_AMOUNT). */
function amountWhy(x, name, { zeroOk = false } = {}) {
    if (!isNum(x) || x < 0 || x > DEX.MAX_AMOUNT) return `malformed ${name}`;
    const u = toUnits(x);
    if (!zeroOk && u <= 0n) return `${name} must be at least 0.00000001`;
    return null;
}
const isTicker = (t) => typeof t === 'string' && TICKER_RE.test(t);
const isRef = (r) => typeof r === 'string' && r.length >= 1 && r.length <= 128 && /^[\x20-\x7E]+$/.test(r);

/** Why a trading transaction is malformed (null = well-formed). Who may sign it is the ledger's. */
export function dexShapeWhy(tx) {
    if (!tx || !DEX_TYPES.includes(tx.type)) return 'not a trading transaction';
    const t = tx.type;
    if (t !== 'SDTX_ISSUE' && tx.to !== tx.from) return 'this record is addressed to its signer (to = from)';
    if (t === 'SDTX_ISSUE' || t === 'SDTX_BURN') {
        if (tx.tokenSymbol !== 'SDTX') return 'SDTX records carry tokenSymbol "SDTX"';
        if (!isRef(tx.ref)) return 'a payment reference (ref) of 1-128 printable characters is required';
        if (t === 'SDTX_ISSUE' && NOT_RECIPIENTS.includes(tx.to)) return 'SDTX cannot be issued to ' + tx.to;
        return amountWhy(tx.amount, 'amount');
    }
    if (t === 'ISSUER_SET' || t === 'ISSUER_REVOKE') {
        if (typeof tx.key !== 'string' || canonicalSpki(tx.key) !== tx.key) return 'the issuer key must be a canonical base64 P-256 public key';
        if (t === 'ISSUER_SET' && (!isNum(tx.dailyCap) || tx.dailyCap <= 0 || tx.dailyCap > DEX.MAX_AMOUNT || toUnits(tx.dailyCap) <= 0n)) {
            return 'malformed daily cap';
        }
        return null;
    }
    if (!isTicker(tx.tokenSymbol) || tx.tokenSymbol === 'SDTX') return 'malformed token (a ticker other than SDTX)';
    if (t === 'NETWORK_FEE_SET') return amountWhy(tx.fee, 'network fee', { zeroOk: true });
    if (t === 'ORDER_CANCEL') return typeof tx.orderId === 'string' && /^[0-9a-f]{64}$/.test(tx.orderId) ? null : 'malformed order id';
    if (t === 'SWAP' || t === 'ORDER_PLACE') {
        if (tx.side !== 'buy' && tx.side !== 'sell') return 'side is "buy" or "sell"';
        const a = amountWhy(tx.amount, 'amount');
        if (a) return a;
        if (t === 'SWAP') {
            if (!isInt(tx.deadline) || tx.deadline <= 0) return 'a swap carries a deadline (a block height)';
            return amountWhy(tx.minOut === undefined ? 0 : tx.minOut, 'minimum output', { zeroOk: true });
        }
        if (priceE18(tx.price) <= 0n) return 'malformed price';
        if (!isInt(tx.expiry) || tx.expiry <= 0) return 'an order carries an expiry (a block height)';
        return null;
    }
    // POOL_CREATE / POOL_ADD
    if (tx.source !== undefined && !(typeof tx.source === 'string' && tx.source.length > 0 && tx.source.length <= 128)) return 'malformed source';
    const a = amountWhy(tx.amount, 'token amount', { zeroOk: t === 'POOL_ADD' });
    if (a) return a;
    const s = amountWhy(tx.sdtx === undefined ? 0 : tx.sdtx, 'SDTX amount', { zeroOk: true });
    if (s) return s;
    if (t === 'POOL_CREATE') {
        const v = amountWhy(tx.virtual === undefined ? 0 : tx.virtual, 'virtual cushion', { zeroOk: true });
        if (v) return v;
    } else {
        if (tx.virtual !== undefined) return 'a virtual cushion is set once, at creation';
        if (toUnits(tx.amount) <= 0n && toUnits(tx.sdtx || 0) <= 0n) return 'add tokens, SDTX or both';
    }
    return null;
}

/** The address an OpenChain coin's supply is minted to from RULES_2 (deterministic, keyless). */
export const openSupplyAddress = (ticker) => 'nx_open_' + String(ticker).toLowerCase() + '_system';

/** Why a TOKEN_DEPLOY is malformed under RULES_2 (null = well-formed). Taken tickers: the ledger. */
export function deployShapeWhy(tx) {
    if (!tx || tx.type !== 'TOKEN_DEPLOY') return 'not a deploy';
    if (tx.to !== tx.from) return 'a deploy is addressed to its creator (to = from)';
    if (!isTicker(tx.tokenSymbol)) return 'a ticker is 2-12 capital letters and digits, starting with a letter';
    if (RESERVED_TICKERS.includes(tx.tokenSymbol)) return tx.tokenSymbol + ' is reserved';
    const a = amountWhy(tx.amount, 'supply');
    if (a) return a;
    const meta = tx.token;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'a deploy carries its token record';
    if (meta.chain === 'delchain') {
        if (!isNum(meta.maxFeeSyr) || meta.maxFeeSyr <= 0 || meta.maxFeeSyr > DEX.MAX_AMOUNT) return 'a DelChain deploy says the most SYR it will pay (token.maxFeeSyr)';
        return null;
    }
    if (meta.chain === 'openchain') {
        if (meta.parent !== undefined && meta.parent !== null && !isTicker(meta.parent)) return 'malformed parent ticker';
        if (meta.maxNetworkFeeSyr !== undefined && (!isNum(meta.maxNetworkFeeSyr) || meta.maxNetworkFeeSyr < 0 || meta.maxNetworkFeeSyr > DEX.MAX_AMOUNT)) {
            return 'malformed token.maxNetworkFeeSyr';
        }
        if (meta.supplyTo !== undefined && meta.supplyTo !== openSupplyAddress(tx.tokenSymbol)) {
            return 'an OpenChain supply goes to ' + openSupplyAddress(tx.tokenSymbol);
        }
        return null;
    }
    return 'token.chain is "delchain" or "openchain"';
}

// ── the book ────────────────────────────────────────────────────────────────────────

/** A new book: no markets, no orders, the legacy tickers known. */
export function emptyBook() {
    const tickers = {};
    for (const t of LEGACY_TOKENS) tickers[t.ticker] = { chain: t.chain, creator: t.creator, sources: t.sources.slice(), at: null, parent: null };
    return { v: 1, seq: 0, pools: {}, orders: {}, tickers, netFees: {},
             sdtx: { issued: '0', burned: '0', destroyed: '0', refs: {}, burnRefs: {} }, issuers: {} };
}

const clone = (b) => JSON.parse(JSON.stringify(b));

/** A book as stored by a ledger (a JSON string, an object, or nothing yet). */
export function readBook(stored) {
    if (!stored) return emptyBook();
    const b = typeof stored === 'string' ? JSON.parse(stored) : clone(stored);
    return b && b.v === 1 ? b : emptyBook();
}

/** The pool's price (SDTX per token, scaled 1e18), or 0n without a market. */
export function poolPriceE18(book, ticker) {
    const p = book && book.pools && book.pools[ticker];
    if (!p || units(p.tok) <= 0n) return 0n;
    return ((units(p.sdtx) + units(p.virt)) * E18) / units(p.tok);
}

// ── pool maths ──────────────────────────────────────────────────────────────────────

const poolX = (p) => units(p.sdtx) + units(p.virt);
const kOf = (p) => poolX(p) * units(p.tok);
function buyOut(X, Y, g) { const n = netOf(g); return n > 0n ? (Y * n) / (X + n) : 0n; }
function sellOut(X, Y, g) { const n = netOf(g); return n > 0n ? (X * n) / (Y + n) : 0n; }
// The last unit bought costs no more than P (fee included): (X+n)² ≤ P·(1−fee)·X·Y.
function buyWithin(X, Y, g, P) { const Xn = X + netOf(g); return Xn * Xn * FEE_D * E18 <= P * (FEE_D - FEE_N) * X * Y; }
// The last unit sold earns no less than P (fee included): X·Y·(1−fee) ≥ P·(Y+n)².
function sellWithin(X, Y, g, P) { const Yn = Y + netOf(g); return X * Y * (FEE_D - FEE_N) * E18 >= P * Yn * Yn * FEE_D; }
/** The largest g in [0, hi] for which ok(g) holds (ok holds for small g and fails from some point on). */
function largest(hi, ok) {
    let lo = 0n;
    while (lo < hi) {
        const mid = (lo + hi + 1n) / 2n;
        if (ok(mid)) lo = mid; else hi = mid - 1n;
    }
    return lo;
}

// ── applying ────────────────────────────────────────────────────────────────────────

function ctxHave(ctx, out, address, token) {
    let u = toUnits(Number(ctx.balanceOf(address, token)) || 0);
    for (const [a, t, d] of out.deltas) if (a === address && t === token) u += d;
    return u;
}
const move = (out, from, to, token, u) => { if (u > 0n) { out.deltas.push([from, token, -u], [to, token, u]); } };

// The creator signs FROM the creator address (a weak/legacy creator registers its key first, so
// txrules.ownsFrom accepts it). Deliberately no registry lookup here: the ledgers know balances,
// not the chain, and a lookup one ledger made and the other did not would be a fork.
const isCreator = (t, tx) => !!t && tx.from === t.creator;

function trade(out, token, kind, side, sdtxU, tokU, pool, by, height, extra = {}) {
    out.events.push(Object.assign({ kind, token, side, sdtx: sdtxU.toString(), tokens: tokU.toString(),
                      price: ((poolX(pool) * E18) / units(pool.tok)).toString(), by, height }, extra));
}

function closeOrder(book, token, o, out) {
    const asset = o.side === 'buy' ? 'SDTX' : token;
    move(out, DEX.ORDERS, o.owner, asset, units(o.locked));
    book.orders[token] = (book.orders[token] || []).filter(x => x.id !== o.id);
}

function expireOrders(book, token, height, out) {
    for (const o of (book.orders[token] || []).slice()) if (height > o.expiry) closeOrder(book, token, o, out);
}

/** How much of order `o` the pool can fill right now, within its limit: { g, out }, or null. */
function fillOf(pool, o) {
    const X = poolX(pool), Y = units(pool.tok), P = units(o.price), locked = units(o.locked);
    if (locked <= 0n || Y <= 0n) return null;
    let g, got;
    if (o.side === 'buy') {
        const q = units(o.qty);
        g = largest(locked, (x) => buyWithin(X, Y, x, P) && buyOut(X, Y, x) <= q);
        got = g > 0n ? buyOut(X, Y, g) : 0n;
    } else {
        const real = units(pool.sdtx);
        g = largest(locked, (x) => sellWithin(X, Y, x, P) && sellOut(X, Y, x) <= real);
        got = g > 0n ? sellOut(X, Y, g) : 0n;
    }
    return g > 0n && got > 0n ? { g, out: got } : null;
}

/** Is what is left of order `o` too small ever to fill (it is then closed and refunded)? */
function isDust(pool, o) {
    if (units(o.qty) <= BigInt(DEX.DUST_UNITS) || units(o.locked) <= 0n) return true;
    return o.side === 'buy' && buyOut(poolX(pool), units(pool.tok), units(o.locked)) <= 0n;
}

/** The live order a side fills first: the best price (highest bid, lowest ask), then the oldest. */
function bestOrder(list, side, height) {
    let best = null, bp = 0n;
    for (const o of list) {
        if (o.side !== side || height > o.expiry) continue;
        const p = units(o.price);
        if (!best || (side === 'buy' ? p > bp : p < bp) || (p === bp && o.seq < best.seq)) { best = o; bp = p; }
    }
    return best;
}

/** Fill crossing orders against the pool, best price then oldest, until none crosses. */
function settle(book, token, ctx, out) {
    const pool = book.pools[token];
    if (!pool) return null;
    for (let i = 0; i < DEX.MAX_FILLS_PER_TX; i++) {
        const list = book.orders[token] || [];
        const b = bestOrder(list, 'buy', ctx.height);
        const s = bestOrder(list, 'sell', ctx.height);
        const fb = b ? fillOf(pool, b) : null, fs = s ? fillOf(pool, s) : null;
        if (!fb && !fs) return null;
        const [o, f] = fb && fs ? (b.seq < s.seq ? [b, fb] : [s, fs]) : (fb ? [b, fb] : [s, fs]);
        const kBefore = kOf(pool);
        if (o.side === 'buy') {
            pool.sdtx = (units(pool.sdtx) + f.g).toString();
            pool.tok = (units(pool.tok) - f.out).toString();
            o.locked = (units(o.locked) - f.g).toString();
            o.qty = (units(o.qty) - f.out).toString();
            move(out, DEX.ORDERS, DEX.POOL, 'SDTX', f.g);
            move(out, DEX.POOL, o.owner, token, f.out);
            trade(out, token, 'fill', 'buy', f.g, f.out, pool, o.owner, ctx.height, { order: o.id, limit: o.price });
        } else {
            pool.tok = (units(pool.tok) + f.g).toString();
            pool.sdtx = (units(pool.sdtx) - f.out).toString();
            o.locked = (units(o.locked) - f.g).toString();
            o.qty = (units(o.qty) - f.g).toString();
            move(out, DEX.ORDERS, DEX.POOL, token, f.g);
            move(out, DEX.POOL, o.owner, 'SDTX', f.out);
            trade(out, token, 'fill', 'sell', f.out, f.g, pool, o.owner, ctx.height, { order: o.id, limit: o.price });
        }
        if (kOf(pool) < kBefore) return 'invariant broken: the pool lost value on a fill';
        if (isDust(pool, o)) closeOrder(book, token, o, out);
    }
    return null;
}

function authIssuer(book, ctx) {
    if (ctx.signerKey && ctx.signerKey === ctx.ownerKey) return { owner: true };
    const iss = book.issuers[ctx.signerKey];
    return iss && iss.revoked === null ? { owner: false, iss } : null;
}

const HANDLERS = {
    SWAP(book, tx, ctx, out) {
        const T = tx.tokenSymbol, pool = book.pools[T];
        if (!pool) return `${T} has no market yet`;
        if (ctx.height > tx.deadline) return 'the swap’s deadline has passed';
        expireOrders(book, T, ctx.height, out);
        const g = toUnits(tx.amount), minOut = toUnits(tx.minOut || 0);
        const X = poolX(pool), Y = units(pool.tok), kBefore = kOf(pool);
        if (tx.side === 'buy') {
            if (ctxHave(ctx, out, tx.from, 'SDTX') < g) return `insufficient SDTX: needs ${fromUnits(g)}`;
            const got = buyOut(X, Y, g);
            if (got <= 0n) return 'too small to buy anything';
            if (got < minOut) return `would receive ${fromUnits(got)} ${T}, less than the minimum ${fromUnits(minOut)}`;
            pool.sdtx = (units(pool.sdtx) + g).toString();
            pool.tok = (Y - got).toString();
            move(out, tx.from, DEX.POOL, 'SDTX', g);
            move(out, DEX.POOL, tx.from, T, got);
            trade(out, T, 'swap', 'buy', g, got, pool, tx.from, ctx.height);
        } else {
            if (ctxHave(ctx, out, tx.from, T) < g) return `insufficient ${T}: needs ${fromUnits(g)}`;
            const got = sellOut(X, Y, g);
            if (got <= 0n) return 'too small to sell';
            if (got > units(pool.sdtx)) return `the market holds only ${fromUnits(units(pool.sdtx))} real SDTX`;
            if (got < minOut) return `would receive ${fromUnits(got)} SDTX, less than the minimum ${fromUnits(minOut)}`;
            pool.tok = (Y + g).toString();
            pool.sdtx = (units(pool.sdtx) - got).toString();
            move(out, tx.from, DEX.POOL, T, g);
            move(out, DEX.POOL, tx.from, 'SDTX', got);
            trade(out, T, 'swap', 'sell', got, g, pool, tx.from, ctx.height);
        }
        if (kOf(pool) < kBefore) return 'invariant broken: the pool lost value on a swap';
        return settle(book, T, ctx, out);
    },

    ORDER_PLACE(book, tx, ctx, out) {
        const T = tx.tokenSymbol;
        if (!book.pools[T]) return `${T} has no market yet`;
        if (!(tx.expiry >= ctx.height && tx.expiry <= ctx.height + DEX.MAX_EXPIRY_BLOCKS)) {
            return `the expiry must be a block from ${ctx.height} to ${ctx.height + DEX.MAX_EXPIRY_BLOCKS}`;
        }
        expireOrders(book, T, ctx.height, out);
        const all = Object.values(book.orders).reduce((n, l) => n + l.filter(o => o.owner === tx.from).length, 0);
        if (all >= DEX.MAX_ORDERS_PER_ADDRESS) return `at most ${DEX.MAX_ORDERS_PER_ADDRESS} open orders per address`;
        if ((book.orders[T] || []).length >= DEX.MAX_ORDERS_PER_TOKEN) return `${T} already has ${DEX.MAX_ORDERS_PER_TOKEN} open orders`;
        if (Object.values(book.orders).some(l => l.some(o => o.id === ctx.id))) return 'this order already exists';
        const q = toUnits(tx.amount), P = priceE18(tx.price);
        const lock = tx.side === 'buy' ? ceilDiv(q * P, E18) : q;
        const asset = tx.side === 'buy' ? 'SDTX' : T;
        if (q <= BigInt(DEX.DUST_UNITS) || lock <= 0n) return 'the order is too small';
        if (ctxHave(ctx, out, tx.from, asset) < lock) return `insufficient ${asset}: the order locks ${fromUnits(lock)}`;
        move(out, tx.from, DEX.ORDERS, asset, lock);
        book.seq += 1;
        (book.orders[T] = book.orders[T] || []).push({ id: ctx.id, owner: tx.from, side: tx.side, price: P.toString(),
            qty: q.toString(), locked: lock.toString(), seq: book.seq, expiry: tx.expiry, at: ctx.height });
        return settle(book, T, ctx, out);
    },

    ORDER_CANCEL(book, tx, ctx, out) {
        const T = tx.tokenSymbol;
        const o = (book.orders[T] || []).find(x => x.id === tx.orderId);
        if (!o) return 'no such open order (filled, cancelled or expired)';
        if (o.owner !== tx.from) return 'only the order’s owner can cancel it';
        closeOrder(book, T, o, out);
        expireOrders(book, T, ctx.height, out);
        return null;
    },

    POOL_CREATE(book, tx, ctx, out) {
        const T = tx.tokenSymbol;
        if (book.pools[T]) return `${T} already has a market (one per token, never reset)`;
        const t = book.tickers[T];
        if (T === 'SYR') {
            if (!ctx.signerKey || ctx.signerKey !== ctx.ownerKey) return 'only the owner key creates the SYR market';
        } else if (!t) {
            return `${T} is not a known token`;
        } else if (!isCreator(t, tx)) {
            return `only ${T}’s creator can create its market`;
        }
        const tok = toUnits(tx.amount), sdtx = toUnits(tx.sdtx || 0), virt = toUnits(tx.virtual || 0);
        if (sdtx + virt <= 0n) return 'a market needs real SDTX or a virtual cushion to set its price';
        if (T !== 'SYR' && virt > toUnits(DEX.VIRTUAL_CAP)) return `the virtual cushion is at most ${DEX.VIRTUAL_CAP} SDTX`;
        const source = tx.source === undefined ? tx.from : tx.source;
        if (source !== tx.from && !(t && t.sources.includes(source))) return `${source} is not a supply address of ${T}`;
        if (ctxHave(ctx, out, source, T) < tok) return `insufficient ${T} at ${source}: needs ${fromUnits(tok)}`;
        if (ctxHave(ctx, out, tx.from, 'SDTX') < sdtx) return `insufficient SDTX: needs ${fromUnits(sdtx)}`;
        move(out, source, DEX.POOL, T, tok);
        move(out, tx.from, DEX.POOL, 'SDTX', sdtx);
        book.pools[T] = { tok: tok.toString(), sdtx: sdtx.toString(), virt: virt.toString(), creator: tx.from, at: ctx.height };
        book.orders[T] = book.orders[T] || [];
        out.events.push({ kind: 'pool', token: T, sdtx: sdtx.toString(), tokens: tok.toString(), virtual: virt.toString(),
                          price: poolPriceE18(book, T).toString(), by: tx.from, height: ctx.height });
        return null;
    },

    POOL_ADD(book, tx, ctx, out) {
        const T = tx.tokenSymbol, pool = book.pools[T];
        if (!pool) return `${T} has no market yet`;
        const t = book.tickers[T];
        if (T === 'SYR' ? (!ctx.signerKey || ctx.signerKey !== ctx.ownerKey) : !isCreator(t, tx)) return `only ${T}’s creator can add to its market`;
        expireOrders(book, T, ctx.height, out);
        const tok = toUnits(tx.amount), sdtx = toUnits(tx.sdtx || 0);
        const source = tx.source === undefined ? tx.from : tx.source;
        if (source !== tx.from && !(t && t.sources.includes(source))) return `${source} is not a supply address of ${T}`;
        if (ctxHave(ctx, out, source, T) < tok) return `insufficient ${T} at ${source}: needs ${fromUnits(tok)}`;
        if (ctxHave(ctx, out, tx.from, 'SDTX') < sdtx) return `insufficient SDTX: needs ${fromUnits(sdtx)}`;
        const kBefore = kOf(pool);
        move(out, source, DEX.POOL, T, tok);
        move(out, tx.from, DEX.POOL, 'SDTX', sdtx);
        pool.tok = (units(pool.tok) + tok).toString();
        pool.sdtx = (units(pool.sdtx) + sdtx).toString();
        if (kOf(pool) < kBefore) return 'invariant broken: adding liquidity lowered k';
        out.events.push({ kind: 'liquidity', token: T, sdtx: sdtx.toString(), tokens: tok.toString(),
                          price: poolPriceE18(book, T).toString(), by: tx.from, height: ctx.height });
        return settle(book, T, ctx, out);
    },

    SDTX_ISSUE(book, tx, ctx, out) {
        const a = authIssuer(book, ctx);
        if (!a) return 'only the owner key or an appointed issuer key can issue SDTX';
        if (Object.prototype.hasOwnProperty.call(book.sdtx.refs, tx.ref)) return `payment ${tx.ref} was already issued`;
        const amt = toUnits(tx.amount);
        if (!a.owner) {
            a.iss.log = a.iss.log.filter(([h]) => h > ctx.height - DEX.ISSUER_WINDOW);
            const used = a.iss.log.reduce((s, [, u]) => s + units(u), 0n);
            if (used + amt > units(a.iss.cap)) return `over this issuer key’s cap: ${fromUnits(units(a.iss.cap) - used)} SDTX left in the last ${DEX.ISSUER_WINDOW} blocks`;
            a.iss.log.push([ctx.height, amt.toString()]);
        }
        book.sdtx.refs[tx.ref] = ctx.height;
        book.sdtx.issued = (units(book.sdtx.issued) + amt).toString();
        out.deltas.push([tx.to, 'SDTX', amt]);
        out.events.push({ kind: 'issue', token: 'SDTX', sdtx: amt.toString(), to: tx.to, ref: tx.ref, by: tx.from, height: ctx.height });
        return null;
    },

    SDTX_BURN(book, tx, ctx, out) {
        if (!authIssuer(book, ctx)) return 'only the owner key or an appointed issuer key can burn SDTX';
        if (Object.prototype.hasOwnProperty.call(book.sdtx.burnRefs, tx.ref)) return `payout ${tx.ref} was already burned`;
        const amt = toUnits(tx.amount);
        if (ctxHave(ctx, out, tx.from, 'SDTX') < amt) return `insufficient SDTX: needs ${fromUnits(amt)}`;
        book.sdtx.burnRefs[tx.ref] = ctx.height;
        book.sdtx.burned = (units(book.sdtx.burned) + amt).toString();
        out.deltas.push([tx.from, 'SDTX', -amt]);
        out.events.push({ kind: 'burn', token: 'SDTX', sdtx: amt.toString(), ref: tx.ref, by: tx.from, height: ctx.height });
        return null;
    },

    ISSUER_SET(book, tx, ctx) {
        if (!ctx.signerKey || ctx.signerKey !== ctx.ownerKey) return 'only the owner key appoints an issuer key';
        if (tx.key === ctx.ownerKey) return 'the owner key needs no appointment';
        const prev = book.issuers[tx.key];
        book.issuers[tx.key] = { cap: toUnits(tx.dailyCap).toString(), since: ctx.height, revoked: null, log: prev ? prev.log : [] };
        return null;
    },

    ISSUER_REVOKE(book, tx, ctx) {
        if (!ctx.signerKey || ctx.signerKey !== ctx.ownerKey) return 'only the owner key revokes an issuer key';
        const iss = book.issuers[tx.key];
        if (!iss || iss.revoked !== null) return 'this key is not an active issuer';
        iss.revoked = ctx.height;
        return null;
    },

    NETWORK_FEE_SET(book, tx, ctx) {
        const t = book.tickers[tx.tokenSymbol];
        if (!t) return `${tx.tokenSymbol} is not a known token`;
        if (!isCreator(t, tx)) return `only ${tx.tokenSymbol}’s creator sets its network fee`;
        book.netFees[tx.tokenSymbol] = toUnits(tx.fee).toString();
        return null;
    }
};

/**
 * Apply one trading transaction to a book. Pure: `book` is not changed.
 * @param {object} book
 * @param {object} tx         a transaction txrules accepted (shape, signature, key ownership)
 * @param {object} ctx
 * @param {number} ctx.height       this block's index
 * @param {string} ctx.id           txrules.txId(tx) — an order's id
 * @param {string} ctx.signerKey    canonical base64 SPKI of tx.publicKey
 * @param {string} ctx.ownerKey     the pinned owner key (key-record.js OWNER_KEY)
 * @param {(address:string, token:string) => number} ctx.balanceOf   the ledger's balance before this tx
 * @returns {{ok:true, book:object, deltas:Array<[string,string,bigint]>, events:Array<object>} | {ok:false, why:string}}
 */
export function applyDexTx(book, tx, ctx) {
    const handler = tx && HANDLERS[tx.type];
    if (!handler) return { ok: false, why: 'not a trading transaction' };
    const b = clone(book);
    const out = { deltas: [], events: [] };
    let why;
    try { why = handler(b, tx, ctx, out); } catch (e) { why = 'malformed: ' + e.message; }
    return why ? { ok: false, why } : { ok: true, book: b, deltas: out.deltas, events: out.events };
}

/**
 * A TOKEN_DEPLOY's side of the book. Before RULES_2 (`rules2` false) the ledger charges the fee the
 * transaction carries, as it always has, and the ticker is only recorded (first deploy wins).
 * From RULES_2: the ticker must be new; the fee is computed here — DelChain $1.00 in SYR at the SYR
 * market's price (DELCHAIN_FALLBACK_FEE_SYR until it exists), never more than token.maxFeeSyr;
 * OpenChain 1 SDTX plus the parent's NETWORK_FEE_SET fee in SYR to the parent's creator, never more
 * than token.maxNetworkFeeSyr — and its supply goes to openSupplyAddress(ticker).
 * @returns {{ok:true, book:object, fees:(Array<[string,string,bigint,string]>|null), supplyTo:(string|null)} | {ok:false, why:string}}
 *          fees: [payer, token, units, to]; `to` 'system' means destroyed.
 */
export function applyDeploy(book, tx, ctx, { rules2 = false } = {}) {
    const b = clone(book);
    const T = String(tx.tokenSymbol || '');
    const meta = (tx.token && typeof tx.token === 'object') ? tx.token : {};
    const chain = String(meta.chain || '').toLowerCase() === 'openchain' ? 'openchain' : 'delchain';
    if (!rules2) {
        if (T && !b.tickers[T]) {
            const supply = chain === 'openchain' ? (String(meta.supplyTo || '') || openSupplyAddress(T)) : null;
            b.tickers[T] = { chain, creator: tx.from, sources: supply ? [supply] : [], at: ctx.height, parent: meta.parent ? String(meta.parent).toUpperCase() : null };
        }
        return { ok: true, book: b, fees: null, supplyTo: null };
    }
    if (b.tickers[T] || RESERVED_TICKERS.includes(T)) return { ok: false, why: `${T} already exists` };
    const out = { deltas: [] };
    const fees = [];
    let supplyTo = null;
    try {
        if (chain === 'delchain') {
            const syr = b.pools.SYR;
            const fee = syr && units(syr.tok) > 0n
                ? ceilDiv(toUnits(DEX.DELCHAIN_FEE_SDTX) * units(syr.tok), poolX(syr))
                : toUnits(DEX.DELCHAIN_FALLBACK_FEE_SYR);
            if (fee > toUnits(meta.maxFeeSyr)) return { ok: false, why: `the $1.00 fee is ${fromUnits(fee)} SYR now, above this deploy’s limit of ${meta.maxFeeSyr}` };
            if (ctxHave(ctx, out, tx.from, 'SYR') < fee) return { ok: false, why: `insufficient SYR for the deploy fee (${fromUnits(fee)})` };
            fees.push([tx.from, 'SYR', fee, 'system']);
        } else {
            const fee = toUnits(DEX.OPENCHAIN_FEE_SDTX);
            if (ctxHave(ctx, out, tx.from, 'SDTX') < fee) return { ok: false, why: `insufficient SDTX for the OpenChain fee (${fromUnits(fee)})` };
            fees.push([tx.from, 'SDTX', fee, 'system']);
            b.sdtx.destroyed = (units(b.sdtx.destroyed) + fee).toString();
            const parent = meta.parent ? String(meta.parent) : null;
            if (parent) {
                const pt = b.tickers[parent];
                if (!pt) return { ok: false, why: `the parent ${parent} is not a known token` };
                const nf = units(b.netFees[parent] || '0');
                if (nf > toUnits(meta.maxNetworkFeeSyr || 0)) return { ok: false, why: `${parent}’s network fee is ${fromUnits(nf)} SYR, above this deploy’s limit` };
                if (nf > 0n) {
                    if (ctxHave(ctx, out, tx.from, 'SYR') < nf) return { ok: false, why: `insufficient SYR for ${parent}’s network fee (${fromUnits(nf)})` };
                    fees.push([tx.from, 'SYR', nf, pt.creator]);
                }
            }
            supplyTo = openSupplyAddress(T);
        }
    } catch (e) {
        return { ok: false, why: 'malformed: ' + e.message };
    }
    b.tickers[T] = { chain, creator: tx.from, sources: supplyTo ? [supplyTo] : [], at: ctx.height, parent: meta.parent ? String(meta.parent) : null };
    return { ok: true, book: b, fees, supplyTo };
}
