#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════════════
   reconcile-ledger.js — does every stored balance equal the sum of its own transactions?

   WHY THIS EXISTS
   A DataChain-Core node rebuilds balances by replaying the chain. That only works if the
   ledger is INTERNALLY CONSISTENT: for every address,

       stored balance  ==  SUM(credits) - SUM(debits)   over its recorded transactions

   It currently is not, and that is the single reason the primary cannot be switched off:
   value that exists only in the balances snapshot cannot be reconstructed by any client.

   USAGE
       node tools/reconcile-ledger.js [--api <url>] [--token SYR] [--all-tokens]
                                      [--limit N] [--json out.json]

   READ-ONLY. Issues GETs only. Safe against production.
   Exit code 1 if drift is found, 0 if the ledger is clean, 2 on a fatal error.

   To turn a report into a remedy, see tools/reconcile-plan.js.
   ════════════════════════════════════════════════════════════════════════════════ */
import { writeFileSync } from 'fs';
import { makeClient, auditToken, classify, listTokens, money } from './lib/ledger-audit.js';

const DEFAULT_API = 'https://datachain-backend-production.up.railway.app';

const args = process.argv.slice(2);
const argOf = (flag, fallback = null) => {
    const i = args.indexOf(flag);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : fallback;
};
const API = String(argOf('--api', DEFAULT_API)).replace(/\/+$/, '');
const TOKEN = String(argOf('--token', 'SYR')).toUpperCase();
const ALL_TOKENS = args.includes('--all-tokens');
const JSON_OUT = argOf('--json', null);
const LIMIT = parseInt(argOf('--limit', '0'), 10) || 0;

(async () => {
    const get = makeClient(API);

    console.log('════════════════════════════════════════════════════════════════');
    console.log(' LEDGER RECONCILIATION — stored balance vs sum of transactions');
    console.log(' api  :', API);
    console.log(' when :', new Date().toISOString());
    console.log('════════════════════════════════════════════════════════════════');

    let tokens = [TOKEN];
    if (ALL_TOKENS) {
        try {
            tokens = await listTokens(get);
        } catch (err) {
            // Do NOT quietly audit one token and present it as the whole ledger.
            console.error('\nFATAL: could not list tokens (' + err.message + ').');
            console.error('The primary rate-limits reads — wait a minute and retry.');
            console.error('Refusing to audit only ' + TOKEN + ', because a partial audit reads as a clean bill of health.');
            process.exit(2);
        }
    }
    const report = { api: API, generatedAt: new Date().toISOString(), tokens: [] };

    for (const token of tokens) {
        process.stdout.write(`\nAuditing ${token} ... `);
        let result;
        try {
            let first = true;
            result = await auditToken(get, token, {
                limit: LIMIT,
                onHolder: (row) => {
                    if (first) { console.log(''); first = false; }
                    const mark = row.error ? '  ?' : (row.consistent ? '  ok' : ' DRIFT');
                    console.log(`${mark}  ${row.address.slice(0, 34).padEnd(36)}` +
                                ` stored ${money(row.stored).padStart(20)}` +
                                `  from txs ${money(row.derived).padStart(20)}` +
                                (row.consistent || row.error ? '' : `  drift ${money(row.drift)}`));
                    if (row.txCount < row.reportedTotal) {
                        console.log(`        note: only ${row.txCount} of ${row.reportedTotal} transactions were retrievable`);
                    }
                }
            });
            if (first) console.log('no holders');
        } catch (err) {
            console.log(`could not audit (${err.message})`);
            continue;
        }
        const verdict = classify(result.holders);
        report.tokens.push({ ...result, verdict: verdict.verdict, netDrift: verdict.net });
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

    const dirty = report.tokens.filter(t => t.verdict !== 'CLEAN');
    if (dirty.length) {
        console.log('\n PER-TOKEN VERDICT');
        for (const t of dirty) {
            const n = t.holders.filter(h => !h.error && !h.consistent).length;
            console.log(`   ${t.token.padEnd(12)} ${n} address(es), net ${money(t.netDrift).padStart(16)}  -> ${t.verdict}`);
            console.log('       ' + (t.verdict.startsWith('CONSERVED')
                ? 'value moved between accounts without a recorded transaction; totals still balance'
                : 'balances hold value no transaction created; supply is overstated by this amount'));
        }
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
        console.log('   Next: node tools/reconcile-plan.js --all-tokens   (generates a reviewable');
        console.log('   SQL migration; it changes nothing on its own).');
    }
    report.summary = { consistent, drifted, failed, netDrift, worst };
    console.log('════════════════════════════════════════════════════════════════');

    if (JSON_OUT) {
        writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
        console.log('full report written to', JSON_OUT);
    }
    process.exit(drifted > 0 ? 1 : 0);
})().catch(err => { console.error('FATAL:', err.message); process.exit(2); });
