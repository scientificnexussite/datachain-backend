// ════════════════════════════════════════════════════════════════════════════════
// relay.js — this node's ONE door for SIGNED transactions (Step 3, 2026-10-18): api.js
//            POST /api/tx/submit (a transaction signed in a visitor's browser) and p2p.js
//            BROADCAST_TX (peer gossip) both come through admitSigned().
//
// The counterpart of Exe/core/tx-intake.js. The checks are txadmit.js, mirrored in the exe, so
// both nodes give the same verdict on the same transaction; rate limits and storage are each
// node's own. Before this, peer gossip went into the mempool after a from/to/amount look, and a
// browser-signed transaction had no route at all.
// ════════════════════════════════════════════════════════════════════════════════

import pool from './db.js';
import mempool from './mempool.js';
import State from './state.js';
import * as txrules from './txrules.js';
import { cloneState } from './chain-rules.js';
import { admitStatic, admitFunds, debitsOf } from './txadmit.js';
import { DEX_TYPES, applyDexTx, applyDeploy } from './dex.js';

const LIMITS = { PER_SENDER_PER_MIN: 10, RELAY_PER_MIN: 300, PEER_PER_MIN: 1200 };
const hits = new Map();                       // key -> recent times (ms)

/** true (and counted) while `key` is under `perMin` in the last minute. */
function take(key, perMin, now) {
    const list = (hits.get(key) || []).filter(t => now - t < 60000);
    if (list.length >= perMin) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 20000) for (const [k, l] of hits) if (!l.length || now - l[l.length - 1] >= 60000) hits.delete(k);
    return true;
}

const hostOf = (u) => {
    const s = String(u || '').trim();
    try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).hostname.toLowerCase(); } catch (e) { return ''; }
};

/** Is `domain` proven for `uid` on this node (domain_verifications, verified or already used)? */
async function domainProven(uid, domain) {
    const want = hostOf(domain);
    if (!want) return false;
    try {
        const r = await pool.query(
            `SELECT website_url FROM domain_verifications WHERE uid = $1 AND status IN ('verified', 'used')`, [uid]);
        return r.rows.some(row => hostOf(row.website_url) === want);
    } catch (e) {
        return false;
    }
}

/**
 * Admit a signed transaction into this node's mempool (and gossip it when new).
 * @param {object} tx
 * @param {object} o
 * @param {'relay'|'peer'} o.source
 * @param {object} o.nexusChain   the live DataChain
 * @param {number} [o.price]      SYR's current price (state.applyTransaction)
 * @param {(msg:object) => void} [o.broadcast]  p2p broadcast, for transactions from the website
 * @returns {Promise<{success:boolean, status:number, code?:string, why?:string, hash?:string, txId?:string, already?:boolean, queuedFor?:number}>}
 */
export async function admitSigned(tx, { source = 'relay', nexusChain, price = 0, broadcast = null } = {}) {
    const now = Date.now();
    const height = nexusChain.blockCount;                       // the index of the next block
    const fail = (status, code, why) => ({ success: false, status, code, why });
    // (Every request from one connection is counted before this by api.js's relayLimiter.)

    // The same order as Exe/core/tx-intake.js: static checks, "already waiting", rate limits, funds.
    const ruleCtx = txrules.ruleIndex(nexusChain._ruleBlocks || []).ctx();
    const s = admitStatic(tx, { source, now, height, ctx: ruleCtx });
    if (!s.ok) return fail(s.status, s.code, s.why);
    if (mempool.hasHash(tx.hash)) return { success: true, status: 200, already: true, hash: tx.hash, txId: s.id, queuedFor: height };
    if (!take('from:' + tx.from, LIMITS.PER_SENDER_PER_MIN, now)) return fail(429, 'rate-limited', 'too many transactions from this address: wait a minute');

    const meta = tx.type === 'TOKEN_DEPLOY' && tx.token && typeof tx.token === 'object' ? tx.token : null;
    const proven = meta && String(meta.chain || '').toLowerCase() === 'delchain' && meta.website
        ? await domainProven(tx.from, meta.website) : false;
    const rules2 = txrules.rules2Active(height, ruleCtx.params);
    const st = nexusChain.state;
    const f = admitFunds(tx, {
        source, rules2,
        waiting: mempool.waitingFrom(tx.from),
        balanceOf: (a, t) => nexusChain.getBalance(a, t),
        // The ledger's own refusal, in the exe's words (state-db strictCheck): trading records and
        // RULES_2 deploys ask the same engine; anything else first the balance, then a COPY of the
        // ledger applied with the overspend floor.
        strictCheck: (x) => {
            if (DEX_TYPES.includes(x.type)) {
                if (!rules2) return 'on-chain trading is not active at this height';
                const r = applyDexTx(st.dex, x, st._dexCtx(x, height));
                return r.ok ? null : r.why;
            }
            if (x.type === 'TOKEN_DEPLOY' && rules2) {
                const r = applyDeploy(st.dex, x, st._dexCtx(x, height), { rules2: true });
                return r.ok ? null : r.why;
            }
            for (const [t, need] of debitsOf(x, { rules2 })) {
                const have = Number((Number(nexusChain.getBalance(x.from, t)) || 0).toFixed(8));
                if (have < need) return `insufficient ${t}: ${x.from} holds ${have}, needs ${need}`;
            }
            const copy = cloneState(nexusChain.state, State);
            if (typeof copy.applyCorrections === 'function') copy.applyCorrections(height);
            const ok = copy.applyTransaction(JSON.parse(JSON.stringify(x)), price, false, { floor: true, height });
            return ok === true ? null : 'the ledger refuses it (balance, or not allowed for this account)';
        },
        isDomainVerified: () => proven,
        // Taken = a registry row OR anyone holding it (legacy coins may exist only as balances).
        tokenExists: (t) => {
            const st = nexusChain.state;
            const held = st.balances && st.balances[t] && Object.values(st.balances[t]).some(v => Number(v) > 0);
            return !!((st.tokens && st.tokens[t]) || (st.openTokens && st.openTokens[t]) || held);
        },
        minDeployFeeSyr: () => (price > 0 ? Number((1 / price).toFixed(8)) : 0)        // $1.00 in SYR
    });
    if (!f.ok) return fail(f.status, f.code, f.why);
    // The node-wide budgets count only what would be STORED: signatures from fresh, empty keys cost
    // nothing to make, and must not use up the relay for everyone else (as Exe/core/tx-intake.js).
    if (source === 'relay' && !take('relay', LIMITS.RELAY_PER_MIN, now)) return fail(429, 'busy', 'this node is relaying many transactions right now: try again in a minute');
    if (source === 'peer' && !take('peer', LIMITS.PEER_PER_MIN, now)) return fail(429, 'busy', 'peer intake is full this minute');
    const v = { id: s.id };

    const stored = await mempool.addSignedTransaction(tx);
    if (!stored.ok) return fail(503, 'mempool-full', 'this node’s queue is full: try again after the next block');
    if (stored.already) return { success: true, status: 200, already: true, hash: tx.hash, txId: v.id, queuedFor: height };
    if (typeof broadcast === 'function') { try { broadcast({ type: 'BROADCAST_TX', data: tx }); } catch (e) { /* peers get it with the block */ } }
    return { success: true, status: 202, already: false, hash: tx.hash, txId: v.id, queuedFor: height };
}

/** Where a transaction stands on this node: pending, mined (with confirmations), or unknown. */
export async function txStatus(hash, { nexusChain } = {}) {
    const h = String(hash || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) return { status: 'invalid', why: 'not a transaction hash' };
    if (mempool.hasHash(h)) return { status: 'pending', hash: h, nextBlock: nexusChain.blockCount };
    try {
        const r = await pool.query(`SELECT block_index FROM transactions WHERE tx_json::jsonb ->> 'hash' = $1 LIMIT 1`, [h]);
        if (r.rows.length) {
            const block = Number(r.rows[0].block_index);
            return { status: 'mined', hash: h, block, confirmations: Math.max(1, nexusChain.blockCount - block) };
        }
    } catch (e) { /* tx_json missing on very old rows */ }
    return { status: 'unknown', hash: h };
}
