#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════════════
   reconcile-plan.js — turn a drift report into a REVIEWABLE SQL migration.

   THIS TOOL NEVER TOUCHES THE DATABASE. It audits over the public API and writes a .sql
   file for a human to read, understand and run. Nothing here connects to Postgres, so it
   cannot corrupt anything by accident — the dangerous step stays deliberate and manual.

   ── THE TWO REMEDIES ────────────────────────────────────────────────────────────
   Drift means `state_balances` (a snapshot, authoritative on boot) disagrees with the
   `transactions` log. Exactly one of them has to be declared truth:

     --mint     BALANCES ARE TRUTH. Emit a correcting MINT/BURN transaction for each
                drifted address so the log finally explains the balance. NOBODY'S BALANCE
                CHANGES. On SYR this makes ~70,300 SYR of previously-undocumented supply
                official and visible in the supply figures — which it already is in
                substance, just unrecorded.

     --restate  TRANSACTIONS ARE TRUTH. Rewrite `state_balances` to the replayed totals.
                THIS REDUCES REAL USER BALANCES. On SYR three holders would lose 21,000 /
                47,600 / 1,700 SYR. Only choose this if the drift is believed to be
                erroneous credit rather than lost records.

   ── WHICH ONE IS RIGHT HERE ─────────────────────────────────────────────────────
   The evidence favours --mint for SYR, and it is worth stating so the choice is informed:
     - every SYR drift is an EXACT multiple of the 50 SYR block reward (420, 952 and 34
       rewards; 1,406 in total). Erroneous credits would not land on exact reward units.
     - `state_balances` is a snapshot that survives independently of the chain, so rewards
       earned under a chain history the current 358-block chain no longer contains persist
       in balances with no surviving transaction. That is a LOST RECORD, not invented value.
   Under that reading the supply was genuinely earned and --restate would confiscate it.
   The decision is still the operator's: this tool only makes both executable.

   A CONSERVED token (drift sums to zero, e.g. GAMECASH) is a different case entirely —
   value was misattributed, not created. --mint documents it as a transfer between the
   affected accounts, preserving the total.

   USAGE
       node tools/reconcile-plan.js --mint --all-tokens [--out plan.sql]
       node tools/reconcile-plan.js --restate --token SYR [--out plan.sql]

   Then READ the .sql, and run it yourself inside a transaction, with a backup taken.
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
const MINT = args.includes('--mint');
const RESTATE = args.includes('--restate');
const OUT = argOf('--out', 'reconcile-plan.sql');

if (MINT === RESTATE) {
    console.error('Choose exactly one remedy: --mint (balances are truth) or --restate (transactions are truth).');
    console.error('Run `node tools/reconcile-ledger.js --all-tokens` first if you have not seen the drift yet.');
    process.exit(2);
}

const sqlStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";

(async () => {
    const get = makeClient(API);
    console.log('Auditing before planning (the plan must be built from the SAME rules as the audit)...');

    let tokens = [TOKEN];
    if (ALL_TOKENS) {
        try {
            tokens = await listTokens(get);
        } catch (err) {
            console.error('FATAL: could not list tokens (' + err.message + '). The primary rate-limits reads; retry shortly.');
            process.exit(2);
        }
    }

    const audited = [];
    for (const token of tokens) {
        try {
            const result = await auditToken(get, token);
            const verdict = classify(result.holders);
            audited.push({ token, holders: result.holders, ...verdict });
            console.log(`  ${token.padEnd(12)} ${verdict.drifted.length} drifted, net ${money(verdict.net)} -> ${verdict.verdict}`);
        } catch (err) {
            console.error(`  ${token.padEnd(12)} could not audit: ${err.message}`);
            console.error('  Refusing to emit a partial plan. Fix the read and retry.');
            process.exit(2);
        }
    }

    const withDrift = audited.filter(t => t.drifted.length > 0);
    if (!withDrift.length) {
        console.log('\nLedger is already consistent — no plan needed.');
        process.exit(0);
    }

    const now = Date.now();
    const L = [];
    L.push('-- ════════════════════════════════════════════════════════════════════');
    L.push('-- LEDGER RECONCILIATION PLAN');
    L.push('-- generated : ' + new Date().toISOString());
    L.push('-- api       : ' + API);
    L.push('-- remedy    : ' + (MINT ? 'MINT (balances are truth; no balance changes)'
                                     : 'RESTATE (transactions are truth; BALANCES WILL CHANGE)'));
    L.push('--');
    L.push('-- READ THIS BEFORE RUNNING:');
    L.push('--   1. Take a database backup. This edits the authoritative ledger.');
    L.push('--   2. Run inside the BEGIN/COMMIT below so a partial apply cannot happen.');
    L.push('--   3. Restart the API afterwards: state.loadSnapshot() reads state_balances');
    L.push('--      on boot, so a running process still holds the OLD numbers in memory');
    L.push('--      and would write them back over these on its next snapshot.');
    if (RESTATE) {
        L.push('--   4. THIS REDUCES REAL USER BALANCES. Reconcile deposits and withdrawals');
        L.push('--      first, and tell affected users before running it.');
    }
    L.push('-- ════════════════════════════════════════════════════════════════════');
    L.push('');
    L.push('BEGIN;');
    L.push('');

    let statements = 0;
    for (const t of withDrift) {
        L.push('-- ── ' + t.token + ' — ' + t.verdict + ', net ' + money(t.net) + ' ──');
        if (t.conserved) {
            L.push('--    Drift sums to zero: value was misattributed, not created. Totals stay intact.');
        } else {
            L.push('--    Drift does NOT sum to zero: ' + (t.net > 0 ? 'supply is OVERSTATED' : 'supply is UNDERSTATED')
                   + ' by ' + money(Math.abs(t.net)) + ' ' + t.token + '.');
        }

        for (const h of t.drifted) {
            const amount = Math.abs(h.drift);
            L.push('');
            L.push('--    ' + h.address);
            L.push('--      stored ' + money(h.stored) + '  |  from transactions ' + money(h.derived)
                   + '  |  drift ' + money(h.drift));
            if (MINT) {
                // Document the balance with a transaction. A positive drift means the
                // address holds MORE than its log explains -> record the missing credit.
                const isCredit = h.drift > 0;
                L.push('--      -> record the missing ' + (isCredit ? 'credit' : 'debit') + '; balance unchanged');
                L.push(`INSERT INTO transactions
    (block_index, from_address, to_address, amount, amount_usd, price_usd, type,
     token_symbol, timestamp_ms, is_system_generated, signature, public_key,
     platform_type, description)
VALUES
    (NULL, ${isCredit ? sqlStr('system') : sqlStr(h.address)}, ${isCredit ? sqlStr(h.address) : sqlStr('system')},
     ${amount}, 0, 0, ${sqlStr(isCredit ? 'MINT' : 'TRANSFER')}, ${sqlStr(t.token)}, ${now}, TRUE, '', '', '',
     ${sqlStr('Ledger reconciliation: records ' + (isCredit ? 'credit' : 'debit') + ' of ' + money(amount)
              + ' ' + t.token + ' present in state_balances but absent from the transaction log')});`);
                statements++;
            } else {
                L.push('--      -> restate the balance to the replayed total'
                       + (h.drift > 0 ? '  (REDUCES this holder by ' + money(h.drift) + ')'
                                      : '  (INCREASES this holder by ' + money(-h.drift) + ')'));
                L.push(`UPDATE state_balances SET balance = ${h.derived}
 WHERE address = ${sqlStr(h.address)} AND token_symbol = ${sqlStr(t.token)};`);
                statements++;
            }
        }
        L.push('');
    }

    L.push('-- Verify BEFORE committing. Re-run the audit in another shell if you want:');
    L.push('--     node tools/reconcile-ledger.js --all-tokens');
    L.push('-- If anything looks wrong: ROLLBACK;');
    L.push('COMMIT;');
    L.push('');

    writeFileSync(OUT, L.join('\n'), 'utf8');

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log(' PLAN WRITTEN — nothing has been changed');
    console.log('   file       :', OUT);
    console.log('   remedy     :', MINT ? 'MINT (no balance changes)' : 'RESTATE (BALANCES WILL CHANGE)');
    console.log('   statements :', statements);
    console.log('   tokens     :', withDrift.map(t => t.token).join(', '));
    if (RESTATE) {
        const losers = withDrift.flatMap(t => t.drifted.filter(h => h.drift > 0));
        console.log('\n   WARNING: ' + losers.length + ' holder(s) would LOSE balance:');
        for (const h of losers) console.log('     -' + money(h.drift).padStart(16), h.address.slice(0, 40));
    }
    console.log('\n   Next: read the file, take a backup, run it in a transaction,');
    console.log('   then RESTART the API so the snapshot is not written back over it.');
    console.log('════════════════════════════════════════════════════════════════');
})().catch(err => { console.error('FATAL:', err.message); process.exit(2); });
