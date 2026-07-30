// Unit tests for the daily epoch settlement driver.
//   run:  node tests/epoch.test.js          (from DataChain_Core/)
// The first block of tests PROVES the feature is inert on the live chain; the rest prove it
// behaves correctly once activated. Re-run both before setting a real EPOCH_1_HEIGHT.
import { isEpochBoundary, epochNumber, buildEpochTransactions, getVerifiedWorkReceipts,
         EPOCH_1_HEIGHT, EPOCH_BLOCKS, latestCommittedRoots } from '../epoch.js';

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

// ── F15: checkpoint commitment + storage rewards ──────────────────────────────
{
    const ROOT = 'ab'.repeat(32);
    const r = buildEpochTransactions({
        height: 8640, treasuryBalance: 100000, treasuryAddress: 'nexus-ai-treasury',
        epochPool: 10000,
        receipts: [{ address: 'host1', f: 100, q: 1, u: 1 }],
        checkpointRoot: ROOT
    });
    const cp = r.txs[0];
    A(cp.type === 'CHECKPOINT', 'the checkpoint commitment is FIRST in the block');
    A(cp.root === ROOT, 'the commitment carries the Merkle root');
    A(cp.amount === 0, 'the commitment moves no value');
    A(r.summary.checkpointCommitted === true, 'the summary reports the commitment');
    A(r.checkpointRoot === ROOT, 'the committed root is returned for the caller to record');

    // obligations must stay index-aligned with txs, or a rejected payout re-queues the
    // WRONG host's debt.
    A(r.obligations.length === r.txs.length, 'obligations stay index-aligned with txs');
    A(r.obligations[0] === null, 'the checkpoint slot holds no obligation');
    for (let i = 1; i < r.txs.length; i++) {
        A(r.obligations[i] && r.obligations[i].address === r.txs[i].to,
          'each payout tx maps to its own obligation');
    }
}
{
    // A malformed root must NOT be committed — nodes would agree on a root that nothing
    // can be proven against, and every storage proof would fail invisibly.
    for (const bad of ['', 'xyz', 'ab'.repeat(10), null, undefined, 12345, 'zz'.repeat(32)]) {
        const r = buildEpochTransactions({
            height: 8640, treasuryBalance: 1000, treasuryAddress: 'nexus-ai-treasury',
            epochPool: 100, receipts: [], checkpointRoot: bad
        });
        A(!r.txs.some(t => t.type === 'CHECKPOINT'), 'a malformed root is not committed: ' + String(bad));
        A(r.summary.checkpointCommitted === false, 'the summary reports no commitment');
    }
    const upper = buildEpochTransactions({
        height: 8640, treasuryBalance: 1000, treasuryAddress: 'nexus-ai-treasury',
        epochPool: 100, receipts: [], checkpointRoot: 'AB'.repeat(32)
    });
    A(upper.txs[0].root === 'ab'.repeat(32), 'a root is normalised to lower case for byte-identical blocks');
}
{
    // Storage rewards ride the same F22 queue and the same solvency invariant.
    const r = buildEpochTransactions({
        height: 8640, treasuryBalance: 100000, treasuryAddress: 'nexus-ai-treasury',
        epochPool: 10000,
        receipts: [{ address: 'compute1', f: 100, q: 1, u: 1 }],
        storage: [{ address: 'keeper1', amount: 25, chunks: 5 },
                  { address: 'keeper2', amount: 10, chunks: 2 }],
        checkpointRoot: 'cd'.repeat(32)
    });
    const store = r.txs.filter(t => /Storage Reward/.test(t.description || ''));
    A(store.length === 2, 'storage providers are paid');
    A(store.some(t => t.to === 'keeper1' && t.amount === 25), 'a storage reward pays the right amount');
    A(/5 chunks/.test(store.find(t => t.to === 'keeper1').description), 'the chunk count is recorded');
    A(r.summary.storagePaid === 2, 'the summary counts storage payouts');
}
{
    // Storage must not break solvency: a treasury that cannot cover everything leaves the
    // remainder PENDING rather than paying money it does not have.
    const r = buildEpochTransactions({
        height: 8640, treasuryBalance: 30, treasuryAddress: 'nexus-ai-treasury',
        epochPool: 10000,
        receipts: [{ address: 'compute1', f: 100, q: 1, u: 1 }],
        storage: [{ address: 'keeper1', amount: 1000, chunks: 5 }]
    });
    const paid = r.txs.filter(t => t.type === 'TRANSFER').reduce((s, t) => s + t.amount, 0);
    A(paid <= 30, 'storage rewards never exceed the treasury balance (F8)');
    A(r.summary.balanceAfter >= 0, 'the balance never goes negative');
    A(r.pending.length > 0, 'what could not be covered stays PENDING');
}
{
    // Compute is paid before storage, storage before everything else (F22 ordering).
    const r = buildEpochTransactions({
        height: 8640, treasuryBalance: 1e9, treasuryAddress: 'nexus-ai-treasury',
        epochPool: 1000,
        receipts: [{ address: 'zzz-compute', f: 100, q: 1, u: 1 }],
        storage: [{ address: 'aaa-keeper', amount: 5, chunks: 1 }]
    });
    const order = r.txs.filter(t => t.type === 'TRANSFER').map(t => t.to);
    A(order.indexOf('zzz-compute') < order.indexOf('aaa-keeper'),
      'compute is paid before storage even when the address sorts later');
}
{
    // Determinism must survive the new fields.
    const args = {
        height: 8640, treasuryBalance: 100000, treasuryAddress: 'nexus-ai-treasury',
        epochPool: 10000, checkpointRoot: 'ef'.repeat(32),
        receipts: [{ address: 'h2', f: 50, q: 1, u: 1 }, { address: 'h1', f: 50, q: 1, u: 1 }],
        storage: [{ address: 's2', amount: 5, chunks: 1 }, { address: 's1', amount: 5, chunks: 1 }]
    };
    const a = buildEpochTransactions(args);
    const b = buildEpochTransactions({
        ...args,
        receipts: args.receipts.slice().reverse(),
        storage: args.storage.slice().reverse()
    });
    A(JSON.stringify(a.txs) === JSON.stringify(b.txs),
      'the block is byte-identical regardless of receipt and storage order');
}

// ── the snapshot root committed ON-CHAIN (removes the last trust gap) ─────────
{
    const SNAP = 'cd'.repeat(32), CP = 'ab'.repeat(32);
    const r = buildEpochTransactions({
        height: 8640, treasuryBalance: 1000, treasuryAddress: 'nexus-ai-treasury',
        epochPool: 100, receipts: [], checkpointRoot: CP, snapshotRoot: SNAP
    });
    const cp = r.txs[0];
    A(cp.type === 'CHECKPOINT', 'a single commitment tx carries both roots');
    A(cp.snapshotRoot === SNAP, 'the STATE snapshot root is committed on-chain');
    A(cp.checkpointRoot === CP, 'the model checkpoint root is committed on-chain');
    A(cp.root === CP, '`root` stays the model checkpoint for backward compatibility');
    A(r.summary.snapshotCommitted && r.summary.checkpointCommitted, 'the summary reports both');

    // Reading them back out is what lets a new node trust NO server.
    const found = latestCommittedRoots([{ index: 8640, data: r.txs }]);
    A(found && found.snapshotRoot === SNAP, 'the snapshot root can be read back from the chain');
    A(found.checkpointRoot === CP, 'the checkpoint root can be read back from the chain');
}
{
    // A snapshot root alone must still commit — the state hand-off does not depend on
    // there being a model checkpoint yet.
    const SNAP = 'ef'.repeat(32);
    const r = buildEpochTransactions({
        height: 8640, treasuryBalance: 1000, treasuryAddress: 'nexus-ai-treasury',
        epochPool: 100, receipts: [], snapshotRoot: SNAP
    });
    A(r.txs[0].type === 'CHECKPOINT' && r.txs[0].snapshotRoot === SNAP,
      'a state root commits even with no model checkpoint');
    A(r.txs[0].checkpointRoot === null, 'no model checkpoint is claimed when there is none');
    A(/State Snapshot Root/.test(r.txs[0].description), 'the description says what was committed');
    A(r.obligations.length === r.txs.length && r.obligations[0] === null,
      'obligations stay aligned when only the state root is committed');
}
{
    // Newest commitment wins, and malformed ones never enter the chain.
    const chain = [
        { index: 1, data: [{ type: 'CHECKPOINT', snapshotRoot: '11'.repeat(32), epoch: 1 }] },
        { index: 2, data: [{ type: 'TRANSFER', from: 'a', to: 'b', amount: 1 }] },
        { index: 3, data: [{ type: 'CHECKPOINT', snapshotRoot: '22'.repeat(32), epoch: 2 }] }
    ];
    const found = latestCommittedRoots(chain);
    A(found.snapshotRoot === '22'.repeat(32), 'the MOST RECENT committed root wins');
    A(found.epoch === 2 && found.height === 3, 'the commitment epoch and height are reported');

    A(latestCommittedRoots([{ index: 1, data: [{ type: 'CHECKPOINT', snapshotRoot: 'garbage' }] }]) === null,
      'a malformed committed root is ignored, not returned as canonical');
    A(latestCommittedRoots([]) === null, 'an empty chain commits nothing');
    A(latestCommittedRoots(null) === null, 'a missing chain is handled safely');
    A(latestCommittedRoots([{ index: 1, data: [] }]) === null, 'a chain with no commitment returns null');
}

console.log('ALL ' + n + ' EPOCH TESTS PASSED');
