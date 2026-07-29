// ════════════════════════════════════════════════════════════════════════════════
// integrity.js — the ledger's self-consistency invariant.
//
// THE INVARIANT, for every address and token:
//
//     stored balance  ==  SUM(credits) - SUM(debits)   over its recorded transactions
//
// WHY THIS MODULE EXISTS
// `state_balances` is a SNAPSHOT (state.saveSnapshot writes it, state.loadSnapshot reads it
// back as authoritative on boot). `transactions` rows are written per block by a SEPARATE
// path. Nothing reconciled the two, so a balance that once entered the snapshot survived
// forever even after its block and transaction were gone. That is how ~70,300 SYR came to
// exist in balances with no transaction to explain it — undetected for months, and
// unrecoverable by any client, because the value lives only in the snapshot.
//
// The drift was never the real problem. The real problem was that NOTHING WAS CHECKING.
// This module is the check: run it at boot and periodically, and a future divergence
// surfaces in hours instead of never.
//
// ── THIS FILE OWNS THE LEDGER SEMANTICS ─────────────────────────────────────────
// `deltaFor` is the single source of truth for what a transaction does to a balance.
// tools/lib/ledger-audit.js imports it rather than keeping its own copy: an auditor that
// disagrees with the ledger invents drift that is not there and misses drift that is.
// If state.js applyTransaction ever changes, change it HERE too — they must agree.
// ════════════════════════════════════════════════════════════════════════════════

export const INTEGRITY_DEFAULTS = {
    EPS: 0.01,          // cent-level tolerance; float replay never lands exactly
    MAX_REPORT: 200     // cap the report so one bad migration cannot flood the logs
};

/**
 * Net effect of one transaction on `address` for `token`, mirroring state.js
 * applyTransaction:
 *   MINT                          credit `to` only (there is no sender)
 *   USD_DEPOSIT / USD_WITHDRAWAL  move DOLLARS, not tokens
 *   LIQUIDITY_INIT                seeds pool reserves; debits nobody
 *   BUY / SELL                    counterparty is `system` (sender/receiver rewritten)
 *   TRANSFER / MARKET_TRADE       debit sender, credit receiver
 * `system` is the SYR mint authority and is never debited.
 */
export function deltaFor(tx, address, token) {
    if (!tx) return 0;
    const type = String(tx.type || 'TRANSFER').toUpperCase();
    const sym = String(tx.tokenSymbol || tx.token_symbol || tx.token || 'SYR').toUpperCase();
    if (sym !== String(token).toUpperCase()) return 0;
    if (type === 'USD_DEPOSIT' || type === 'USD_WITHDRAWAL') return 0;
    if (type === 'LIQUIDITY_INIT') return 0;

    const amt = parseFloat(tx.amount) || 0;
    if (!amt) return 0;

    const from = tx.from ?? tx.from_address;
    const to = tx.to ?? tx.to_address;

    if (type === 'MINT') return (to || from) === address ? amt : 0;

    let sender = from, receiver = to;
    if (type === 'BUY') { receiver = (to && to !== 'system') ? to : from; sender = 'system'; }
    else if (type === 'SELL') { sender = (from && from !== 'system') ? from : to; receiver = 'system'; }

    let delta = 0;
    if (receiver === address && receiver !== 'system') delta += amt;
    if (sender === address && sender !== 'system' && sender !== 'NETWORK') delta -= amt;
    return delta;
}

/**
 * Replay transactions into balances: { token: { address: amount } }.
 * This is what the ledger SHOULD look like if every balance is explained by its history.
 */
export function deriveBalances(transactions) {
    const out = {};
    for (const tx of (Array.isArray(transactions) ? transactions : [])) {
        if (!tx) continue;
        const type = String(tx.type || 'TRANSFER').toUpperCase();
        if (type === 'USD_DEPOSIT' || type === 'USD_WITHDRAWAL' || type === 'LIQUIDITY_INIT') continue;

        const token = String(tx.tokenSymbol || tx.token_symbol || tx.token || 'SYR').toUpperCase();
        if (!out[token]) out[token] = {};

        // Touch both endpoints so an address that nets to zero still APPEARS in the derived
        // ledger — otherwise a stored zero balance and a missing one look different when
        // they are not, and the comparison reports phantom drift.
        for (const addr of [tx.from ?? tx.from_address, tx.to ?? tx.to_address]) {
            if (!addr || addr === 'system' || addr === 'NETWORK') continue;
            const d = deltaFor(tx, addr, token);
            out[token][addr] = (out[token][addr] || 0) + d;
        }
    }
    return out;
}

/**
 * Compare stored balances against replayed ones.
 *
 * @param {object} stored  { token: { address: amount } } — the snapshot
 * @param {object} derived { token: { address: amount } } — from deriveBalances
 * @returns {{consistent:boolean, checked:number, drifted:Array, netDrift:number,
 *            byToken:Object}}
 */
export function compareLedger(stored, derived, { eps = INTEGRITY_DEFAULTS.EPS } = {}) {
    const drifted = [];
    const byToken = {};
    let checked = 0, netDrift = 0;

    // Union of tokens AND addresses: a balance present on only ONE side is the most
    // serious case (value with no history, or history with no value), so it must not be
    // skipped just because its counterpart is absent.
    const tokens = new Set([...Object.keys(stored || {}), ...Object.keys(derived || {})]);
    for (const token of tokens) {
        const s = (stored && stored[token]) || {};
        const d = (derived && derived[token]) || {};
        const addrs = new Set([...Object.keys(s), ...Object.keys(d)]);
        let tokenNet = 0, tokenCount = 0;

        for (const address of addrs) {
            const sv = Number(s[address]) || 0;
            const dv = Number(d[address]) || 0;
            checked++;
            const drift = sv - dv;
            if (Math.abs(drift) < eps) continue;
            tokenCount++;
            tokenNet += drift;
            netDrift += drift;
            if (drifted.length < INTEGRITY_DEFAULTS.MAX_REPORT) {
                drifted.push({ token, address, stored: sv, derived: dv, drift });
            }
        }
        if (tokenCount) {
            byToken[token] = {
                count: tokenCount,
                net: tokenNet,
                // Same classification as the audit tool: drift that cancels within a token
                // is misattribution (recoverable); drift that does not is supply that no
                // transaction created.
                verdict: Math.abs(tokenNet) < eps ? 'CONSERVED (misattribution)'
                                                  : 'UNCONSERVED (phantom supply)'
            };
        }
    }

    drifted.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
    return { consistent: drifted.length === 0, checked, drifted, netDrift, byToken };
}

/**
 * One-call check: transactions in, verdict out.
 * `stored` is the snapshot shape state.js keeps: { token: { address: amount } }.
 */
export function checkLedger({ stored, transactions, eps } = {}) {
    return compareLedger(stored || {}, deriveBalances(transactions), { eps });
}

/**
 * Human-readable summary for logs. Written to be impossible to skim past — the previous
 * failure was silence, so this errs loudly on the side of being noticed.
 */
export function formatReport(result, { limit = 10 } = {}) {
    if (!result) return '[INTEGRITY] no result';
    if (result.consistent) {
        return `[INTEGRITY] OK — ${result.checked} balances all match their transaction history.`;
    }
    const lines = [
        '',
        '!'.repeat(72),
        '[INTEGRITY] LEDGER IS INCONSISTENT — balances disagree with their own history.',
        `[INTEGRITY]   positions checked : ${result.checked}`,
        `[INTEGRITY]   positions drifted : ${result.drifted.length}`,
        `[INTEGRITY]   net unexplained   : ${result.netDrift}`,
        '[INTEGRITY]   (positive = balances hold MORE than their transactions account for)'
    ];
    for (const [token, v] of Object.entries(result.byToken)) {
        lines.push(`[INTEGRITY]   ${token}: ${v.count} address(es), net ${v.net} -> ${v.verdict}`);
    }
    for (const d of result.drifted.slice(0, limit)) {
        lines.push(`[INTEGRITY]     ${d.token} ${String(d.address).slice(0, 42)} stored ${d.stored} vs ${d.derived} (drift ${d.drift})`);
    }
    if (result.drifted.length > limit) {
        lines.push(`[INTEGRITY]     ... and ${result.drifted.length - limit} more`);
    }
    lines.push('[INTEGRITY] A node CANNOT rebuild this state by replaying the chain, and the');
    lines.push('[INTEGRITY] unexplained value exists ONLY here — it cannot be recovered elsewhere.');
    lines.push('[INTEGRITY] Run: node tools/reconcile-ledger.js --all-tokens');
    lines.push('!'.repeat(72));
    lines.push('');
    return lines.join('\n');
}
