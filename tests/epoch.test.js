// Unit tests for the daily epoch settlement driver.
//   run:  node tests/epoch.test.js          (from DataChain_Core/)
// The first block of tests PROVES the feature is inert on the live chain; the rest prove it
// behaves correctly once activated. Re-run both before setting a real EPOCH_1_HEIGHT.
import { isEpochBoundary, epochNumber, buildEpochTransactions, getVerifiedWorkReceipts,
         EPOCH_1_HEIGHT, EPOCH_BLOCKS } from '../epoch.js';

let n = 0; const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── SAFETY: the feature must be completely inert on the live chain ────────
A(EPOCH_1_HEIGHT === Number.MAX_SAFE_INTEGER, 'epoch settlement is dormant');
A(getVerifiedWorkReceipts().length === 0, 'no receipts exist yet (M0 hand-off)');
for (const h of [0, 1, 8640, 17280, 1e6, 1344577, 1e9, 1e12]) {
    A(isEpochBoundary(h) === false, 'no epoch boundary fires while dormant at height ' + h);
}
A(isEpochBoundary(NaN) === false, 'NaN height is not a boundary');
A(isEpochBoundary(-5) === false, 'negative height is not a boundary');
A(isEpochBoundary(undefined) === false, 'undefined height is not a boundary');

// ── epoch numbering ──────────────────────────────────────────────────────
A(EPOCH_BLOCKS === 8640, 'epoch is one day at the 10s block time');
A(epochNumber(0) === 0, 'height 0 is epoch 0');
A(epochNumber(8639) === 0, 'the first epoch is not complete before 8640');
A(epochNumber(8640) === 1, 'height 8640 closes epoch 1');
A(epochNumber(17280) === 2, 'height 17280 closes epoch 2');
A(epochNumber(-1) === 0, 'negative height clamps to epoch 0');

// ── ACTIVATED BEHAVIOUR (drive the builder directly) ─────────────────────
const TREASURY = 'nexus-ai-treasury';
const receipts = [
    { address: 'hostA', f: 1e9, q: 1,   u: 1,   home: true },
    { address: 'hostB', f: 5e8, q: 0.9, u: 0.8, home: false }
];
{
    const pool = EPOCH_BLOCKS * 13;    // 112,320 SYR accrued in one epoch
    const r = buildEpochTransactions({
        height: 8640, treasuryAddress: TREASURY, treasuryBalance: pool, epochPool: pool, receipts
    });
    A(r.txs.length === 2, 'both hosts are paid');
    A(r.txs.every(t => t.from === TREASURY), 'payouts come from the treasury address');
    A(r.txs.every(t => t.type === 'TRANSFER' && t.tokenSymbol === 'SYR'), 'payouts are SYR transfers');
    A(r.txs.every(t => t.isSystemGenerated === true), 'payouts are marked system-generated');
    A(r.txs.every(t => t.amount > 0), 'no zero-value payout transactions');
    A(r.txs.every(t => /epoch 1/.test(t.description)), 'payouts are labelled with their epoch');
    const total = r.txs.reduce((s, t) => s + t.amount, 0);
    A(total <= pool + 1e-6, 'F8: an epoch never pays out more than the pool');
    A(r.summary.epoch === 1 && r.summary.height === 8640, 'summary reports the right epoch');
    A(near(r.summary.totalPaid, total), 'summary total matches the transactions');
    A(r.obligations.length === r.txs.length, 'every payout tx maps back to its obligation');
    A(r.obligations.every((o, i) => o.address === r.txs[i].to && near(o.amount, r.txs[i].amount)),
        'obligations[i] corresponds to txs[i] (needed to re-queue a rejected payout)');
}
{
    // treasury short of funds -> nothing overdrawn, everything carried
    const r = buildEpochTransactions({
        height: 8640, treasuryAddress: TREASURY, treasuryBalance: 0,
        epochPool: EPOCH_BLOCKS * 13, receipts
    });
    A(r.txs.length === 0, 'an empty treasury emits no payout transactions');
    A(r.pending.length === 2, 'both obligations are carried to the next epoch');
    A(r.summary.balanceAfter === 0, 'balance stays at zero, never negative');
}
{
    // no treasury address configured -> safe no-op, queue preserved
    const carried = [{ id: 'x', address: 'h', amount: 5, priority: 0, since: 1 }];
    const r = buildEpochTransactions({ height: 8640, treasuryAddress: null, carriedPending: carried });
    A(r.txs.length === 0 && r.summary === null, 'missing treasury address settles nothing');
    A(r.pending === carried, 'the pending queue is preserved untouched');
}
{
    // no receipts (today's reality) -> nothing paid, pool untouched
    const r = buildEpochTransactions({
        height: 8640, treasuryAddress: TREASURY, treasuryBalance: 1e6,
        epochPool: EPOCH_BLOCKS * 13, receipts: []
    });
    A(r.txs.length === 0, 'no verified work means no payouts');
    A(r.summary.totalPaid === 0, 'nothing leaves the treasury without receipts');
}
{
    // determinism: receipt order must not change the batch
    const a = buildEpochTransactions({ height: 8640, treasuryAddress: TREASURY, treasuryBalance: 1e6, epochPool: 1e5, receipts });
    const b = buildEpochTransactions({ height: 8640, treasuryAddress: TREASURY, treasuryBalance: 1e6, epochPool: 1e5, receipts: receipts.slice().reverse() });
    const strip = (r) => JSON.stringify(r.txs.map(t => [t.from, t.to, t.amount]));
    A(strip(a) === strip(b), 'every node builds an identical batch regardless of receipt order');
}

console.log('ALL ' + n + ' EPOCH TESTS PASSED');
