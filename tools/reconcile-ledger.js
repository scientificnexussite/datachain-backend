#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════════════
   reconcile-ledger.js — does every stored balance equal the sum of its own transactions?

   WHY THIS EXISTS
   A DataChain-Core node rebuilds balances by replaying the chain. That only works if the
   ledger is INTERNALLY CONSISTENT: for every address,

       stored balance  ==  SUM(credits) - SUM(debits)   over its recorded transactions

   It currently is not. `nexus-system-miner` holds 18,600 SYR while its own 338 recorded
   transactions total 16,900 — the transaction COUNT agrees exactly, but the balance is
   1,700 higher. A number that exists in the balances table and nowhere else cannot be
   reconstructed by any client, which is precisely why the primary cannot be switched off
   yet: shutting it down would destroy the only copy of that information.

   This tool measures the full extent of the drift so it can be decided, per address,
   which side is the truth.

   USAGE
       node tools/reconcile-ledger.js [--api <url>] [--token SYR] [--json out.json]
                                      [--limit N] [--all-tokens]

     --api         API base (default: the production URL below)
     --token       token to audit (default SYR)
     --all-tokens  audit every token from /tokens instead of just one
     --limit       only check the first N holders (default: all)
     --json        also write the full report as JSON

   READ-ONLY. It issues GETs and changes nothing. Safe to run against production.

   SEMANTICS — mirrors state.js applyTransaction, because auditing with the WRONG rules
   invents drift that is not there:
     MINT                          credit `to` only (no sender exists)
     USD_DEPOSIT / USD_WITHDRAWAL  move DOLLARS, not tokens -> ignored for a token audit
     LIQUIDITY_INIT                seeds pool reserves; debits nobody
     BUY / SELL                    counterparty is `system` (rewritten sender/receiver)
     TRANSFER / MARKET_TRADE       debit sender, credit receiver
   `system` is the SYR mint authority and is never debited.
   ════════════════════════════════════════════════════════════════════════════════ */

// ESM: this package is "type": "module", so `require` does not exist here.
import { writeFileSync } from 'fs';

const DEFAULT_API = 'https://datachain-backend-production.up.railway.app';

const args = process.argv.slice(2);
const argOf = (flag, fallback = null) => {
    const i = args.indexOf(flag);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : fallback;
};
const API        = String(argOf('--api', DEFAULT_API)).replace(/\/+$/, '');
const TOKEN      = String(argOf('--token', 'SYR')).toUpperCase();
const ALL_TOKENS = args.includes('--all-tokens');
const JSON_OUT   = argOf('--json', null);
const LIMIT      = parseInt(argOf('--limit', '0'), 10) || 0;

const EPS = 0.01;                       // cent-level tolerance for float noise
const money = (n) => (Math.round(n * 1e6) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });

async function get(path, tries = 3) {
    let lastErr;
    for (let attempt = 0; attempt < tries; attempt++) {
        try {
            const r = await fetch(API + path, { signal: AbortSignal.timeout(30000) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
        } catch (err) {
            lastErr = err;
            if (attempt < tries - 1) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
    throw lastErr;
}

/** Net effect of one transaction on `address`, under the primary's own per-type rules. */
function deltaFor(tx, address, token) {
    const type = String(tx.type || 'TRANSFER').toUpperCase();
    const sym  = String(tx.tokenSymbol || tx.token || 'SYR').toUpperCase();
    if (sym !== token) return 0;
    if (type === 'USD_DEPOSIT' || type === 'USD_WITHDRAWAL') return 0;   // dollars, not tokens
    if (type === 'LIQUIDITY_INIT') return 0;                             // pool reserves

    const amt = parseFloat(tx.amount) || 0;
    if (!amt) return 0;

    if (type === 'MINT') return (tx.to || tx.from) === address ? amt : 0;

    let sender = tx.from, receiver = tx.to;
    if (type === 'BUY')       { receiver = (tx.to && tx.to !== 'system') ? tx.to : tx.from; sender = 'system'; }
    else if (type === 'SELL') { sender = (tx.from && tx.from !== 'system') ? tx.from : tx.to; receiver = 'system'; }

    let delta = 0;
    if (receiver === address && receiver !== 'system') delta += amt;
    if (sender === address && sender !== 'system' && sender !== 'NETWORK') delta -= amt;
    return delta;
}

async function fetchAllTx(address, token) {
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

async function auditToken(token) {
    process.stdout.write(`\nAuditing ${token} ... `);
    let holders = [];
    try {
        const h = await get(`/holders/${encodeURIComponent(token)}?limit=1000`);
        holders = h.topHolders || h.holders || (Array.isArray(h) ? h : []);
    } catch (err) {
        console.log(`could not list holders (${err.message})`);
        return null;
    }
    if (LIMIT) holders = holders.slice(0, LIMIT);
    console.log(`${holders.length} holders`);

    const rows = [];
    for (const holder of holders) {
        const address = holder.address || holder.uid;
        if (!address) continue;
        const stored = Number(holder.balance) || 0;
        let derived = 0, txCount = 0, reported = 0, error = null;
        try {
            const { rows: txs, reportedTotal } = await fetchAllTx(address, token);
            txCount = txs.length;
            reported = reportedTotal;
            for (const tx of txs) derived += deltaFor(tx, address, token);
        } catch (err) {
            error = err.message;
        }
        const drift = stored - derived;
        rows.push({ address, stored, derived, drift, txCount, reportedTotal: reported, error,
                    consistent: !error && Math.abs(drift) < EPS });
        const mark = error ? '  ?' : (Math.abs(drift) < EPS ? '  ok' : ' DRIFT');
        console.log(`${mark}  ${address.slice(0, 34).padEnd(36)} stored ${money(stored).padStart(20)}` +
                    `  from txs ${money(derived).padStart(20)}` +
                    (Math.abs(drift) < EPS ? '' : `  drift ${money(drift)}`));
        if (txCount < reported) {
            console.log(`        note: only ${txCount} of ${reported} transactions were retrievable`);
        }
    }
    return { token, holders: rows };
}

(async () => {
    console.log('════════════════════════════════════════════════════════════════');
    console.log(' LEDGER RECONCILIATION — stored balance vs sum of transactions');
    console.log(' api  :', API);
    console.log(' when :', new Date().toISOString());
    console.log('════════════════════════════════════════════════════════════════');

    let tokens = [TOKEN];
    if (ALL_TOKENS) {
        try {
            const list = await get('/tokens');
            tokens = (Array.isArray(list) ? list : [])
                .map(t => String(t.ticker || '').toUpperCase()).filter(Boolean);
        } catch (err) {
            console.log('could not list tokens, falling back to', TOKEN, `(${err.message})`);
        }
    }

    const report = { api: API, generatedAt: new Date().toISOString(), tokens: [] };
    for (const token of tokens) {
        const result = await auditToken(token);
        if (result) report.tokens.push(result);
    }

    let consistent = 0, drifted = 0, failed = 0, worst = null, netDrift = 0;
    for (const t of report.tokens) {
        for (const h of t.holders) {
            if (h.error) { failed++; continue; }
            if (h.consistent) { consistent++; continue; }
            drifted++;
            netDrift += h.drift;
            if (!worst || Math.abs(h.drift) > Math.abs(worst.drift)) worst = { ...h, token: t.token };
        }
    }

    // ── Classify each token's drift. The distinction decides the remedy ──────────
    // CONSERVED (per-token drift sums to ~0): no value was created or destroyed, it is
    //   attributed to the wrong accounts — a RECORDING GAP. The transfer really happened;
    //   its transactions are just missing from the queryable history. Recoverable: find
    //   the missing transactions and the totals already agree.
    // UNCONSERVED (sums to non-zero): supply exists in balances that NO transaction ever
    //   created (or was destroyed without a record). This is PHANTOM SUPPLY and cannot be
    //   explained by any missing transfer, because a transfer always has two sides.
    console.log('\n PER-TOKEN VERDICT');
    for (const t of report.tokens) {
        const bad = t.holders.filter(h => !h.error && !h.consistent);
        if (!bad.length) continue;
        const net = bad.reduce((s, h) => s + h.drift, 0);
        const conserved = Math.abs(net) < EPS;
        t.verdict = conserved ? 'CONSERVED (misattribution)' : 'UNCONSERVED (phantom supply)';
        t.netDrift = net;
        console.log(`   ${t.token.padEnd(12)} ${bad.length} address(es), net ${money(net).padStart(16)}  -> ${t.verdict}`);
        console.log('       ' + (conserved
            ? 'value moved between accounts without a recorded transaction; totals still balance'
            : 'balances hold value no transaction created; supply is overstated by this amount'));
    }

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log(' SUMMARY');
    console.log('   addresses consistent :', consistent);
    console.log('   addresses DRIFTED    :', drifted);
    if (failed) console.log('   could not be checked :', failed);
    console.log('   net unexplained      :', money(netDrift), '(positive = balances hold MORE than their transactions)');
    if (worst) console.log('   largest single drift :', money(worst.drift), `(${worst.token} ${worst.address.slice(0, 34)})`);

    if (drifted === 0 && failed === 0) {
        console.log('\n   The ledger is INTERNALLY CONSISTENT: every balance equals the sum of its');
        console.log('   transactions, so a node can rebuild state by replaying the chain.');
    } else {
        console.log('\n   The ledger is NOT internally consistent, so a node CANNOT rebuild state by');
        console.log('   replaying the chain — and the primary cannot be switched off without losing');
        console.log('   the only copy of the unexplained value.');
        console.log('   Remedy depends on the verdict above:');
        console.log('     CONSERVED   -> recoverable. Locate the missing transactions (they exist:');
        console.log('                    the totals already balance) and backfill the history.');
        console.log('     UNCONSERVED -> a decision is required, because supply is overstated:');
        console.log('                    (a) treat balances as truth and mint correcting transactions,');
        console.log('                        which makes the phantom supply official; or');
        console.log('                    (b) treat transactions as truth and restate balances, which');
        console.log('                        REDUCES REAL USER BALANCES — reconcile deposits and');
        console.log('                        withdrawals first, and tell affected users.');
    }
    report.summary = { consistent, drifted, failed, netDrift, worst };
    console.log('════════════════════════════════════════════════════════════════');

    if (JSON_OUT) {
        writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
        console.log('full report written to', JSON_OUT);
    }
    process.exit(drifted > 0 ? 1 : 0);
})().catch(err => { console.error('FATAL:', err.message); process.exit(2); });
