// The treasury's pending queue must survive a restart AND be checkable against the chain.
//   run:  node tests/pending-restart.test.js          (from DataChain_Core/)
//
// ── THE BUG THIS PINS SHUT ─────────────────────────────────────────────────────
// datachain.js held `treasuryPending` in memory only — never persisted, never in the state
// snapshot, never rebuilt on replay. A restart reset it to [], so two nodes with different
// uptimes carried different debts, built different payout batches, and therefore DIFFERENT
// BLOCKS. It was harmless only because settlement was dormant; it becomes a fork the moment
// receipts are real, which is exactly what this milestone makes them.
//
// These tests drive the save/load pair directly rather than booting a DataChain (which
// needs Postgres), because the property under test is the file/chain agreement, not the
// node lifecycle.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pendingRoot, verifyPendingList } from '../receipts.js';
import { buildEpochTransactions, latestCommittedRoots } from '../epoch.js';

let n = 0; const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };

const TREASURY = 'nexus-ai-treasury';
const RECEIPTS = [
    { address: 'hostA', f: 1e9, q: 1,   u: 1,   home: true },
    { address: 'hostB', f: 5e8, q: 0.9, u: 0.8, home: false }
];

// The save/load pair from datachain.js, isolated so the invariant can be exercised without
// a database. Kept deliberately identical in shape to the real methods.
function savePending(file, list) {
    fs.writeFileSync(file, JSON.stringify({ root: pendingRoot(list), pending: list }));
}
function loadPending(file, chain) {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    const list = Array.isArray(raw.pending) ? raw.pending : [];
    const committed = latestCommittedRoots(chain);
    const wanted = committed ? committed.pendingRoot : null;
    return verifyPendingList(list, wanted) ? list : [];
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pending-'));
const FILE = path.join(tmp, 'treasury_pending.json');

// ── an epoch that cannot pay carries its debts, and commits their root ─────────
const settlement = buildEpochTransactions({
    height: 8640, treasuryAddress: TREASURY,
    treasuryBalance: 0,                 // treasury is empty: nothing can be paid
    epochPool: 112320, receipts: RECEIPTS
});
A(settlement.pending.length === 2, 'both debts are carried');
A(typeof settlement.pendingRoot === 'string', 'the queue commits a root');

// The block the epoch produced, as a node would hold it.
const chain = [{ index: 8640, data: settlement.txs }];

{
    // THE ORIGINAL BUG: a restart with no persistence starts empty while the chain says
    // two debts are outstanding.
    const naive = [];
    A(!verifyPendingList(naive, settlement.pendingRoot),
        'an empty queue does NOT match a chain that recorded two debts — this is the fork');
}

{
    savePending(FILE, settlement.pending);
    const restored = loadPending(FILE, chain);
    A(restored.length === 2, 'a restart restores both obligations');
    A(restored[0].address && restored[0].amount > 0, 'restored rows carry real debts');
    A(verifyPendingList(restored, settlement.pendingRoot), 'and they match the on-chain root');
}

{
    // TWO NODES, DIFFERENT UPTIMES, SAME CHAIN — the scenario that forked.
    const nodeA = loadPending(FILE, chain);                 // ran through the epoch
    const fresh = path.join(tmp, 'fresh.json');
    savePending(fresh, settlement.pending);                 // synced the queue from a peer
    const nodeB = loadPending(fresh, chain);
    A(pendingRoot(nodeA) === pendingRoot(nodeB),
        'two nodes with different histories derive the SAME queue from the same chain');

    // And the next epoch therefore builds the same batch on both.
    const a = buildEpochTransactions({ height: 17280, treasuryAddress: TREASURY,
        treasuryBalance: 1e6, epochPool: 0, receipts: [], carriedPending: nodeA });
    const b = buildEpochTransactions({ height: 17280, treasuryAddress: TREASURY,
        treasuryBalance: 1e6, epochPool: 0, receipts: [], carriedPending: nodeB });
    A(JSON.stringify(a.txs) === JSON.stringify(b.txs),
        'the next epoch settles byte-identically on both nodes');
}

{
    // A TAMPERED FILE MUST BE REFUSED, not trusted. Each of these is someone quietly
    // changing who the treasury owes.
    const tampered = settlement.pending.map(o => ({ ...o }));
    tampered[0].amount = 1e9;
    savePending(FILE, tampered);
    // savePending recomputes the root, so the file is self-consistent — the CHAIN is what
    // catches it. That is the whole reason the root is committed on-chain rather than only
    // stored beside the list.
    A(loadPending(FILE, chain).length === 0,
        'a queue whose amounts were edited is refused against the on-chain root');

    const extra = settlement.pending.concat([
        { id: 'e1:evil', address: 'attacker', amount: 5e5, priority: 0, since: 1 }
    ]);
    savePending(FILE, extra);
    A(loadPending(FILE, chain).length === 0, 'an INSERTED debt is refused');

    savePending(FILE, [settlement.pending[0]]);
    A(loadPending(FILE, chain).length === 0, 'a DELETED debt is refused');
}

{
    // Corruption and absence must fail closed, not throw.
    fs.writeFileSync(FILE, 'not json at all');
    let threw = false;
    try { loadPending(FILE, chain); } catch (e) { threw = true; }
    A(threw, 'a corrupt file throws here — datachain.js catches it and starts empty');

    fs.rmSync(FILE, { force: true });
    A(loadPending(FILE, chain).length === 0, 'a missing file yields an empty queue');
}

{
    // An epoch that owes nothing commits no pending root, and an empty queue agrees with it.
    const paid = buildEpochTransactions({
        height: 8640, treasuryAddress: TREASURY,
        treasuryBalance: 1e6, epochPool: 112320, receipts: RECEIPTS
    });
    A(paid.pending.length === 0, 'a funded treasury carries nothing');
    A(paid.pendingRoot === null, 'and commits no pending root');
    A(verifyPendingList([], null), 'an empty queue agrees with an absent root');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`ALL ${n} PENDING-RESTART TESTS PASSED`);
