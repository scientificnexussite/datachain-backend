/* ════════════════════════════════════════════════════════════════════════════════
   integrity.test.js — the ledger self-consistency invariant.

   This is the check that did not exist, which is why ~70,300 SYR sat unexplained in the
   balances snapshot for months. The tests therefore care most about DETECTION: the exact
   historical failure must be caught, and equally important, normal healthy ledgers must
   NOT be flagged — a check that cries wolf gets switched off and the next real drift goes
   unnoticed again.
   ════════════════════════════════════════════════════════════════════════════════ */
import {
    deltaFor, deriveBalances, compareLedger, checkLedger, formatReport
} from '../integrity.js';

let n = 0;
const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const tx = (o) => Object.assign({ type: 'TRANSFER', tokenSymbol: 'SYR' }, o);

// ── per-type semantics must mirror state.js ───────────────────────────────────
A(deltaFor(tx({ from: 'a', to: 'b', amount: 10 }), 'b', 'SYR') === 10, 'TRANSFER credits the receiver');
A(deltaFor(tx({ from: 'a', to: 'b', amount: 10 }), 'a', 'SYR') === -10, 'TRANSFER debits the sender');
A(deltaFor(tx({ from: 'system', to: 'b', amount: 10 }), 'system', 'SYR') === 0, 'system is never debited (mint authority)');
A(deltaFor(tx({ type: 'MINT', from: 'system', to: 'b', amount: 10 }), 'b', 'SYR') === 10, 'MINT credits the receiver');
A(deltaFor(tx({ type: 'MINT', from: 'x', to: 'b', amount: 10 }), 'x', 'SYR') === 0, 'MINT has no sender to debit');
A(deltaFor(tx({ type: 'USD_DEPOSIT', from: 'a', to: 'a', amount: 50 }), 'a', 'SYR') === 0, 'USD_DEPOSIT moves dollars, not tokens');
A(deltaFor(tx({ type: 'USD_WITHDRAWAL', from: 'a', to: 'a', amount: 50 }), 'a', 'SYR') === 0, 'USD_WITHDRAWAL moves dollars, not tokens');
A(deltaFor(tx({ type: 'LIQUIDITY_INIT', from: 'system', to: 'pool', amount: 100 }), 'pool', 'SYR') === 0, 'LIQUIDITY_INIT debits nobody');
A(deltaFor(tx({ type: 'BUY', from: 'buyer', to: null, amount: 7 }), 'buyer', 'SYR') === 7, 'BUY credits the buyer, system is the counterparty');
A(deltaFor(tx({ type: 'SELL', from: 'seller', to: null, amount: 7 }), 'seller', 'SYR') === -7, 'SELL debits the seller');
A(deltaFor(tx({ from: 'a', to: 'b', amount: 10, tokenSymbol: 'GAMECASH' }), 'b', 'SYR') === 0, 'a different token does not affect this one');
A(deltaFor(tx({ from_address: 'a', to_address: 'b', amount: 10, token_symbol: 'SYR' }), 'b', 'SYR') === 10, 'raw DB column names are accepted');
A(deltaFor(null, 'a', 'SYR') === 0, 'a missing transaction contributes nothing');
A(deltaFor(tx({ from: 'a', to: 'b', amount: 0 }), 'b', 'SYR') === 0, 'a zero-amount transaction contributes nothing');

// ── replay ────────────────────────────────────────────────────────────────────
{
    const d = deriveBalances([
        tx({ type: 'MINT', from: 'system', to: 'alice', amount: 100 }),
        tx({ from: 'alice', to: 'bob', amount: 30 }),
        tx({ from: 'bob', to: 'alice', amount: 5 })
    ]);
    A(near(d.SYR.alice, 75), 'replay computes alice correctly');
    A(near(d.SYR.bob, 25), 'replay computes bob correctly');
    A(!('system' in d.SYR), 'system is not tracked as a holder');
}
{
    // An address that nets to zero must still APPEAR, or a stored 0 and a missing entry
    // look different when they are not — which would report drift that does not exist.
    const d = deriveBalances([
        tx({ type: 'MINT', from: 'system', to: 'x', amount: 10 }),
        tx({ from: 'x', to: 'y', amount: 10 })
    ]);
    A('x' in d.SYR && near(d.SYR.x, 0), 'an address that nets to zero still appears in the replay');
}
{
    const d = deriveBalances([
        tx({ from: 'a', to: 'b', amount: 5 }),
        tx({ from: 'a', to: 'b', amount: 5, tokenSymbol: 'GAMECASH' })
    ]);
    A(near(d.SYR.b, 5) && near(d.GAMECASH.b, 5), 'tokens are tracked independently');
}
A(Object.keys(deriveBalances([])).length === 0, 'no transactions -> nothing derived');
A(Object.keys(deriveBalances(null)).length === 0, 'null input is safe');

// ── a HEALTHY ledger must not be flagged ──────────────────────────────────────
{
    const txs = [
        tx({ type: 'MINT', from: 'system', to: 'alice', amount: 100 }),
        tx({ from: 'alice', to: 'bob', amount: 40 })
    ];
    const r = checkLedger({ stored: { SYR: { alice: 60, bob: 40 } }, transactions: txs });
    A(r.consistent, 'a consistent ledger passes');
    A(r.drifted.length === 0 && r.netDrift === 0, 'a consistent ledger reports no drift');
    A(r.checked === 2, 'every position is checked');
    A(formatReport(r).includes('OK'), 'a clean report says OK');
}
{
    // Float noise must not be reported as drift, or the check gets ignored.
    const r = checkLedger({
        stored: { SYR: { a: 0.1 + 0.2 } },
        transactions: [tx({ type: 'MINT', from: 'system', to: 'a', amount: 0.3 })]
    });
    A(r.consistent, 'float rounding is within tolerance and not reported');
}

// ── THE HISTORICAL FAILURE must be caught ─────────────────────────────────────
{
    // nexus-system-miner: 338 rewards of 50 = 16,900 recorded, but 18,600 stored.
    const txs = [];
    for (let i = 0; i < 338; i++) {
        txs.push(tx({ from: 'system', to: 'nexus-system-miner', amount: 50, isSystemGenerated: true }));
    }
    const r = checkLedger({ stored: { SYR: { 'nexus-system-miner': 18600 } }, transactions: txs });
    A(!r.consistent, 'the real historical drift is DETECTED');
    A(r.drifted.length === 1, 'exactly the one drifted address is reported');
    A(near(r.drifted[0].drift, 1700), 'the drift amount is exact (18,600 - 16,900)');
    A(r.byToken.SYR.verdict.startsWith('UNCONSERVED'), 'unbalanced drift is classified as phantom supply');
    const out = formatReport(r);
    A(out.includes('INCONSISTENT') && out.includes('reconcile-ledger'),
      'the report is loud and names the tool that diagnoses it');
}
{
    // The GAMECASH shape: drift that CANCELS is misattribution, not phantom supply.
    const r = compareLedger(
        { GC: { a: 100, b: 200 } },
        { GC: { a: 150, b: 150 } }
    );
    A(!r.consistent, 'misattribution is still flagged');
    A(near(r.netDrift, 0), 'conserved drift nets to zero');
    A(r.byToken.GC.verdict.startsWith('CONSERVED'), 'drift that cancels is classified as misattribution');
}

// ── one-sided balances are the most serious case ──────────────────────────────
{
    const r = compareLedger({ SYR: { ghost: 500 } }, { SYR: {} });
    A(!r.consistent, 'a balance with NO transaction history at all is caught');
    A(near(r.drifted[0].drift, 500), 'the whole balance is reported as unexplained');
}
{
    const r = compareLedger({ SYR: {} }, { SYR: { owed: 250 } });
    A(!r.consistent, 'history with no stored balance is caught');
    A(near(r.drifted[0].drift, -250), 'the shortfall is reported as negative drift');
}
{
    const r = compareLedger({}, { NEWTOKEN: { a: 5 } });
    A(!r.consistent, 'a token present only in history is caught');
    A(r.byToken.NEWTOKEN, 'the unseen token is named');
}

// ── reporting stays usable under mass failure ─────────────────────────────────
{
    const stored = { SYR: {} }, derived = { SYR: {} };
    for (let i = 0; i < 500; i++) { stored.SYR['h' + i] = i + 1; derived.SYR['h' + i] = 0; }
    const r = compareLedger(stored, derived);
    A(r.drifted.length <= 200, 'the report is capped so one bad migration cannot flood the logs');
    A(r.checked === 500, 'every position is still CHECKED even when the report is capped');
    A(near(r.netDrift, 125250), 'the net is computed over ALL drift, not just the reported slice');
    A(Math.abs(r.drifted[0].drift) >= Math.abs(r.drifted[1].drift), 'the worst offenders are reported first');
}

// ── degenerate input ──────────────────────────────────────────────────────────
A(checkLedger({}).consistent, 'no arguments is treated as consistent, not a crash');
A(compareLedger(null, null).consistent, 'null ledgers compare safely');
A(formatReport(null).includes('no result'), 'formatting a missing result is safe');

console.log('ALL ' + n + ' INTEGRITY TESTS PASSED');
