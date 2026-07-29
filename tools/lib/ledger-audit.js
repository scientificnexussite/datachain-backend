// ════════════════════════════════════════════════════════════════════════════════
// lib/ledger-audit.js — shared ledger-consistency logic.
//
// Used by BOTH tools/reconcile-ledger.js (report) and tools/reconcile-plan.js (remedy).
// They must agree exactly: a plan built from different rules than the audit would
// "fix" drift that was never there and miss drift that is.
//
// WHY DRIFT IS POSSIBLE AT ALL (the architecture, verified in state.js):
//   - `state_balances` is a SNAPSHOT, written by state.saveSnapshot() and read back by
//     state.loadSnapshot() as AUTHORITATIVE on boot.
//   - `transactions` rows are written per block, by a separate path.
// The two stores are independent, so any balance that once entered the snapshot survives
// forever even if the block and transaction that produced it no longer exist. That is how
// a balance can legitimately exceed the sum of its own transaction history.
// ════════════════════════════════════════════════════════════════════════════════

// The ledger's semantics live in ONE place — ../../integrity.js. An auditor that keeps
// its own copy of the rules will, sooner or later, disagree with the ledger it audits:
// inventing drift that is not there and missing drift that is. Import, never duplicate.
import { deltaFor, INTEGRITY_DEFAULTS } from '../../integrity.js';

export { deltaFor };
export const EPS = INTEGRITY_DEFAULTS.EPS;

export function makeClient(api) {
    const base = String(api).replace(/\/+$/, '');
    return async function get(path, tries = 3) {
        let lastErr;
        for (let attempt = 0; attempt < tries; attempt++) {
            try {
                const r = await fetch(base + path, { signal: AbortSignal.timeout(30000) });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return await r.json();
            } catch (err) {
                lastErr = err;
                if (attempt < tries - 1) await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
            }
        }
        throw lastErr;
    };
}

export async function fetchAllTx(get, address, token) {
    const out = [];
    let offset = 0, total = null;
    for (;;) {
        const page = await get(`/txhistory/${encodeURIComponent(address)}?token=${token}&limit=200&offset=${offset}`);
        const rows = page.transactions || (Array.isArray(page) ? page : []);
        if (total === null) total = Number(page.total ?? rows.length);
        if (!rows.length) break;
        out.push(...rows);
        offset += rows.length;
        if (out.length >= total || rows.length < 200) break;
    }
    return { rows: out, reportedTotal: total ?? out.length };
}

/** Audit one token. Returns { token, holders:[{address, stored, derived, drift, ...}] }. */
export async function auditToken(get, token, { limit = 0, onHolder = null } = {}) {
    let holders = [];
    const h = await get(`/holders/${encodeURIComponent(token)}?limit=1000`);
    holders = h.topHolders || h.holders || (Array.isArray(h) ? h : []);
    if (limit) holders = holders.slice(0, limit);

    const rows = [];
    for (const holder of holders) {
        const address = holder.address || holder.uid;
        if (!address) continue;
        const stored = Number(holder.balance) || 0;
        let derived = 0, txCount = 0, reportedTotal = 0, error = null;
        try {
            const res = await fetchAllTx(get, address, token);
            txCount = res.rows.length;
            reportedTotal = res.reportedTotal;
            for (const tx of res.rows) derived += deltaFor(tx, address, token);
        } catch (err) {
            error = err.message;
        }
        const row = {
            address, stored, derived, drift: stored - derived, txCount, reportedTotal, error,
            consistent: !error && Math.abs(stored - derived) < EPS
        };
        rows.push(row);
        if (onHolder) onHolder(row);
    }
    return { token, holders: rows };
}

/**
 * Classify a token's drift. The distinction decides the remedy:
 *   CONSERVED   drift sums to ~0 -> value is misattributed, not created. The transfer
 *               happened; its transactions are missing. Recoverable by backfilling them.
 *   UNCONSERVED drift sums to non-zero -> supply exists that no transaction created (or
 *               was destroyed with no record). Cannot be explained by a missing transfer,
 *               because a transfer always has two sides.
 */
export function classify(holders) {
    const bad = holders.filter(h => !h.error && !h.consistent);
    const net = bad.reduce((s, h) => s + h.drift, 0);
    return {
        drifted: bad,
        net,
        conserved: bad.length > 0 && Math.abs(net) < EPS,
        verdict: bad.length === 0 ? 'CLEAN'
               : (Math.abs(net) < EPS ? 'CONSERVED (misattribution)' : 'UNCONSERVED (phantom supply)')
    };
}

/**
 * Every token ticker the primary knows about.
 *
 * Throws rather than silently falling back: a partial audit that LOOKS complete is worse
 * than a failure, because "only SYR drifted" would be read as "every other token is
 * clean" when the others were never checked at all. The primary rate-limits reads, so
 * this legitimately fails when the tool is run repeatedly — the caller must decide.
 */
export async function listTokens(get) {
    const list = await get('/tokens');
    const tokens = (Array.isArray(list) ? list : [])
        .map(t => String(t.ticker || '').toUpperCase()).filter(Boolean);
    if (!tokens.length) throw new Error('primary returned no tokens');
    return tokens;
}

export const money = (n) =>
    (Math.round(n * 1e6) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
