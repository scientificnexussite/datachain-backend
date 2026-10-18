// ════════════════════════════════════════════════════════════════════════════════
// dexview.js — what the on-chain trading book LOOKS LIKE from outside (seven-phase plan Step 5):
//              the /dex/* read routes, a swap quote, and the old /menubook shape, built from the
//              book dex.js keeps. Read-only: nothing here changes a book or a balance.
//
// ⚠️ CODE IN TWO COPIES. Exe/core/dexview.js is the CommonJS twin of this file, so both nodes
// answer every /dex/* route with the same shape and the same numbers for the same book.
// Exe/tests/module-parity.test.mjs checks the mirror is fresh. Change both or neither.
//
// A QUOTE IS THE ENGINE ITSELF. quote() runs dex.applyDexTx on the live book with an unlimited
// balance and reads what the swap would pay out — the exact integer result a block would give,
// not a float estimate. Prices and amounts are returned as NUMBERS for display (prices are SDTX
// per token, which the site shows with a "$"); the book keeps the exact units.
// ════════════════════════════════════════════════════════════════════════════════

import { DEX, applyDexTx, applyDeploy, poolPriceE18, fromUnits, toUnits, dexShapeWhy } from './dex.js';

const E18 = 1000000000000000000n;
const coins = (u) => fromUnits(BigInt(u || 0));
const priceOf = (e18) => Number(BigInt(e18 || 0)) / 1e18;

// The site's warning scale (local-api /api/price-impact, Step 1): it asks for confirmation on 'high'.
export function warningLevel(impactPct) {
    return impactPct < 1 ? 'low' : impactPct < 5 ? 'medium' : 'high';
}

/** One market, or null. */
export function poolView(book, token) {
    const p = book && book.pools && book.pools[token];
    if (!p) return null;
    const price = priceOf(poolPriceE18(book, token));
    const orders = (book.orders[token] || []);
    return {
        token, price,
        tokens: coins(p.tok),                       // tokens in the pool
        sdtxReal: coins(p.sdtx),                    // real SDTX (what sells are paid from)
        sdtxVirtual: coins(p.virt),                 // the cushion set at creation, never paid out
        valueSdtx: Number((coins(p.sdtx) + price * coins(p.tok)).toFixed(8)),
        fee: DEX.FEE_BPS / 10000,
        creator: p.creator, createdAt: p.at,
        openBuys: orders.filter(o => o.side === 'buy').length,
        openSells: orders.filter(o => o.side === 'sell').length
    };
}

/** Every market, by ticker. */
export function poolsView(book) {
    return Object.keys((book && book.pools) || {}).sort().map(t => poolView(book, t));
}

/** One open order as the outside sees it. */
export function orderView(o, token) {
    return {
        id: o.id, token, owner: o.owner, side: o.side,
        price: priceOf(o.price),
        amountLeft: coins(o.qty),                   // tokens still wanted / offered
        locked: coins(o.locked),
        lockedAsset: o.side === 'buy' ? 'SDTX' : token,
        expiry: o.expiry, placedAt: o.at, seq: o.seq
    };
}

/** The open orders of one address, every token, oldest first. */
export function ordersOf(book, address) {
    const out = [];
    for (const t of Object.keys((book && book.orders) || {}).sort()) {
        for (const o of book.orders[t]) if (o.owner === address) out.push(orderView(o, t));
    }
    return out.sort((a, b) => a.seq - b.seq);
}

/** One open order by id, or null. */
export function findOrder(book, id) {
    for (const t of Object.keys((book && book.orders) || {})) {
        const o = book.orders[t].find(x => x.id === id);
        if (o) return orderView(o, t);
    }
    return null;
}

/** Price levels of one side: orders at the same price summed. */
function levels(list, side, max) {
    const by = new Map();
    for (const o of list) {
        if (o.side !== side) continue;
        const l = by.get(o.price) || { e18: BigInt(o.price), units: 0n, orders: 0 };
        l.units += BigInt(o.qty); l.orders += 1;
        by.set(o.price, l);
    }
    return [...by.values()]
        .sort((a, b) => (side === 'buy' ? (b.e18 > a.e18 ? 1 : b.e18 < a.e18 ? -1 : 0) : (a.e18 > b.e18 ? 1 : a.e18 < b.e18 ? -1 : 0)))
        .slice(0, max)
        .map(l => ({ price: priceOf(l.e18), amount: coins(l.units), orders: l.orders }));
}

/**
 * The pool's depth: how much moves the price by each step (no fee; display only). For a constant
 * product the SDTX that lifts the price by p% is X·(√(1+p) − 1); the tokens that drop it by p%,
 * Y·(1/√(1−p) − 1). Sells beyond the pool's REAL SDTX are not possible, so `down` stops there.
 */
function depthCurve(book, token) {
    const p = book.pools[token];
    if (!p) return { up: [], down: [] };
    const X = coins(p.sdtx) + coins(p.virt), Y = coins(p.tok), real = coins(p.sdtx);
    const steps = [0.01, 0.02, 0.05, 0.10, 0.25, 0.50];
    const up = steps.map(s => {
        const sdtx = X * (Math.sqrt(1 + s) - 1);
        return { pct: s * 100, sdtx: Number(sdtx.toFixed(8)), tokens: Number((Y - (X * Y) / (X + sdtx)).toFixed(8)) };
    });
    const down = [];
    for (const s of steps) {
        const tokens = Y * (1 / Math.sqrt(1 - s) - 1);
        const sdtx = X - (X * Y) / (Y + tokens);
        if (sdtx > real) break;
        down.push({ pct: s * 100, tokens: Number(tokens.toFixed(8)), sdtx: Number(sdtx.toFixed(8)) });
    }
    return { up, down };
}

/** The order book of one token: price levels each side, the market, and its depth curve. */
export function bookView(book, token, { maxLevels = 20 } = {}) {
    const list = (book && book.orders && book.orders[token]) || [];
    return { token, bids: levels(list, 'buy', maxLevels), asks: levels(list, 'sell', maxLevels),
             pool: poolView(book, token), depth: book && book.pools && book.pools[token] ? depthCurve(book, token) : { up: [], down: [] } };
}

/**
 * The old /menubook shape the site already renders (bids/asks as {priceUsd, amountSyr} NUMBERS,
 * marketData with numbers, never null), built from the ON-CHAIN book. `fallbackPrice` is used only
 * when the token has no market yet.
 */
export function menubookView(book, token, { fallbackPrice = 0, maxLevels = 20 } = {}) {
    const v = bookView(book, token, { maxLevels });
    const map = (rows, side) => rows.map(l => ({ side, price: l.price, amount: l.amount, priceUsd: l.price, amountSyr: l.amount, orders: l.orders }));
    const bids = map(v.bids, 'BUY'), asks = map(v.asks, 'SELL');
    const highestBid = bids.length ? bids[0].priceUsd : 0;
    const lowestAsk = asks.length ? asks[0].priceUsd : 0;
    const lastTradePrice = v.pool ? v.pool.price : (Number(fallbackPrice) || 0);
    return { bids, asks, onChain: true, pool: v.pool,
             marketData: { highestBid, lowestAsk, spread: highestBid && lowestAsk ? lowestAsk - highestBid : 0, lastTradePrice } };
}

/**
 * What a swap would pay right now: the engine on the live book. { ok:false, why } when it would
 * be refused (no market, too small, more than the real SDTX in the pool …).
 * @param {object} o
 * @param {string} o.token
 * @param {'buy'|'sell'} o.side
 * @param {number} o.amount        what is paid in (SDTX for a buy, the token for a sell)
 * @param {number} o.height        the next block's index
 * @param {number} [o.slippageBps] how far below the quote minOut may be (default 1%)
 * @param {number} [o.deadlineBlocks]
 */
export function quote(book, { token, side, amount, height, slippageBps = 100, deadlineBlocks = 30 } = {}) {
    const slip = Math.min(Math.max(Math.floor(Number(slippageBps) || 0), 0), 5000);
    const deadline = Math.floor(Number(height) || 0) + Math.max(1, Math.floor(Number(deadlineBlocks) || 30));
    const tx = { type: 'SWAP', from: 'nx_quote', to: 'nx_quote', tokenSymbol: token, side, amount: Number(amount), minOut: 0, deadline };
    const shape = dexShapeWhy(tx);
    if (shape) return { ok: false, why: shape };
    if (!book.pools[token]) return { ok: false, why: `${token} has no market yet` };
    const r = applyDexTx(book, tx, { height: Math.floor(Number(height) || 0), id: '0'.repeat(64), signerKey: null, ownerKey: null,
                                     balanceOf: () => DEX.MAX_AMOUNT });
    if (!r.ok) return { ok: false, why: r.why };
    const outAsset = side === 'buy' ? token : 'SDTX';
    const outU = r.deltas.filter(([a, t, d]) => a === 'nx_quote' && t === outAsset && d > 0n).reduce((s, [, , d]) => s + d, 0n);
    const swap = r.events.find(e => e.kind === 'swap');
    const inU = toUnits(tx.amount);
    const before = priceOf(poolPriceE18(book, token));
    const after = swap ? priceOf(swap.price) : before;
    const avg = side === 'buy' ? Number(inU) / Number(outU) : Number(outU) / Number(inU);
    const impactPct = before > 0 ? Math.abs(avg / before - 1) * 100 : 0;
    const minOutU = (outU * BigInt(10000 - slip)) / 10000n;
    return {
        ok: true, token, side, height: Math.floor(Number(height) || 0),
        amountIn: coins(inU), assetIn: side === 'buy' ? 'SDTX' : token,
        amountOut: coins(outU), assetOut: outAsset,
        minOut: coins(minOutU), slippageBps: slip, deadline,
        fee: coins((inU * BigInt(DEX.FEE_BPS) + 9999n) / 10000n),
        priceBefore: before, priceAfter: after, avgPrice: Number(avg.toFixed(12)),
        impactPct: Number(impactPct.toFixed(4)), warningLevel: warningLevel(impactPct),
        ordersFilled: r.events.filter(e => e.kind === 'fill').length
    };
}

/** SDTX: issued, burned, destroyed by fees, and what circulates; the issuer keys. */
export function sdtxView(book, { height = 0 } = {}) {
    const s = (book && book.sdtx) || { issued: '0', burned: '0', destroyed: '0' };
    const issued = BigInt(s.issued || 0), burned = BigInt(s.burned || 0), destroyed = BigInt(s.destroyed || 0);
    const issuers = Object.keys((book && book.issuers) || {}).sort().map(key => {
        const i = book.issuers[key];
        const used = (i.log || []).filter(([h]) => h > height - DEX.ISSUER_WINDOW).reduce((a, [, u]) => a + BigInt(u), 0n);
        return { key, dailyCap: coins(i.cap), usedInWindow: coins(used), since: i.since, revoked: i.revoked, active: i.revoked === null };
    });
    return { issued: coins(issued), burned: coins(burned), destroyed: coins(destroyed),
             circulating: coins(issued - burned - destroyed), issuers };
}

/** A token as the ticker book knows it (creator, product, stranded supply addresses), or null. */
export function tickerView(book, ticker) {
    const t = book && book.tickers && book.tickers[ticker];
    if (!t) return null;
    return { ticker, chain: t.chain, creator: t.creator, sources: t.sources.slice(), createdAt: t.at, parent: t.parent,
             networkFeeSyr: book.netFees && book.netFees[ticker] ? coins(book.netFees[ticker]) : 0, hasMarket: !!book.pools[ticker] };
}

/** One trade (an engine event) in the shape /dex/trades returns on both nodes. */
export function tradeView(e, { txHash = null, timestamp = null } = {}) {
    return { token: e.token, kind: e.kind, side: e.side || null, price: priceOf(e.price),
             sdtx: coins(e.sdtx || 0), tokens: coins(e.tokens || 0), by: e.by || null,
             order: e.order || null, height: e.height, txHash, timestamp };
}

/**
 * What a deploy would cost under RULES_2, from the engine itself: DelChain $1 in SYR at the SYR
 * market (the fallback until it exists); OpenChain 1 SDTX + the parent's NETWORK_FEE_SET fee.
 * { ok:true, syr, sdtx } or { ok:false, why } (e.g. an unknown parent).
 */
export function deployFeeQuote(book, { chain = 'delchain', parent = null, height = 0 } = {}) {
    const token = chain === 'openchain' ? { chain: 'openchain', parent: parent || undefined, maxNetworkFeeSyr: DEX.MAX_AMOUNT }
                                        : { chain: 'delchain', maxFeeSyr: DEX.MAX_AMOUNT };
    const probe = { type: 'TOKEN_DEPLOY', from: 'nx_fee_probe', to: 'nx_fee_probe', tokenSymbol: 'FEEPROBEZZZZ', amount: 1, token };
    const r = applyDeploy(book, probe, { height, balanceOf: () => DEX.MAX_AMOUNT }, { rules2: true });
    if (!r.ok) return { ok: false, why: r.why };
    const sum = (t) => coins(r.fees.filter(f => f[1] === t).reduce((s, f) => s + f[2], 0n));
    return { ok: true, syr: sum('SYR'), sdtx: sum('SDTX') };
}

/** The settlement scale, for clients that want exact numbers. */
export const UNITS = Object.freeze({ amount: 1e8, price: Number(E18) });
