/* ════════════════════════════════════════════════════════════════════════════════
   snapshot.test.js — the Railway hand-off: canonical, verifiable state snapshots.

   This is the mechanism that lets the primary be switched off. The properties under test
   are therefore adversarial: can a peer alter one balance and still pass, can a partial
   snapshot slip through as complete, and do two independent machines derive the SAME root
   from the same state? A failure in any of those means either fake balances propagate, or
   nodes disagree about who owns what.
   ════════════════════════════════════════════════════════════════════════════════ */
import {
    canonicalJSON, buildSnapshot, chunkProof, verifySnapshotChunk,
    parseSnapshot, verifySnapshot, SNAPSHOT_TABLES
} from '../snapshot.js';

let n = 0;
const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };

const sampleTables = () => ({
    state_balances: [
        { address: 'alice', token_symbol: 'SYR', balance: 100.5 },
        { address: 'bob', token_symbol: 'SYR', balance: 250 },
        { address: 'alice', token_symbol: 'GAMECASH', balance: 7 }
    ],
    state_usd_balances: [{ address: 'alice', balance: 42.25 }],
    token_metadata: [{ ticker: 'SYR', name: 'SilverCash', total_supply: 12000000000 }],
    open_tokens: [{ ticker: 'TESTMOVE', name: 'TestMove' }],
    // NOTE the name: the real table is `state_liquidity_pools`. The snapshot originally
    // asked for `liquidity_pools`, which does not exist, so pools silently arrived empty.
    state_liquidity_pools: [
        { token_symbol: 'SYR', token_reserve: 1000, usd_reserve: 530 },
        { token_symbol: 'GAMECASH', token_reserve: 50, usd_reserve: 5 }
    ],
    orders: [{ id: 'o1', uid: 'alice', pair: 'SYR', side: 'BUY', price: 0.5, amount: 10 }]
});

// ── canonical serialization ───────────────────────────────────────────────────
A(canonicalJSON({ b: 1, a: 2 }) === '{"a":2,"b":1}', 'object keys are sorted');
A(canonicalJSON({ a: { z: 1, y: 2 } }) === '{"a":{"y":2,"z":1}}', 'nested keys are sorted too');
A(canonicalJSON([3, 1, 2]) === '[3,1,2]', 'array ORDER is meaningful and preserved');
A(canonicalJSON({ a: 1 }) === canonicalJSON({ a: 1 }), 'canonical form is stable');
{
    // The real hazard: two databases returning the same row with columns in a different
    // order. Without canonicalisation that alone would split the network's view of state.
    const one = { address: 'a', token_symbol: 'SYR', balance: 5 };
    const two = { balance: 5, address: 'a', token_symbol: 'SYR' };
    A(canonicalJSON(one) === canonicalJSON(two),
      'the same row with columns in a different order serialises identically');
}
A(canonicalJSON(null) === 'null', 'null serialises');
A(canonicalJSON(1.5) === '1.5', 'numbers serialise');

// ── build + root ──────────────────────────────────────────────────────────────
{
    const s = buildSnapshot({ tables: sampleTables(), height: 358 });
    A(/^[0-9a-f]{64}$/.test(s.manifest.root), 'the snapshot commits to a Merkle root');
    A(/^[0-9a-f]{64}$/.test(s.manifest.bodyHash), 'the snapshot also hashes the assembled body');
    A(s.manifest.height === 358, 'the manifest records the chain height');
    A(s.manifest.chunkCount === s.chunks.length, 'the manifest chunk count matches reality');
    A(s.manifest.rowCounts.state_balances === 3, 'row counts are reported per table');
    A(s.chunks.length >= 1, 'at least one chunk is produced');
}
{
    // Two independent machines must derive the SAME root from the same state, even when
    // rows arrive in a different order — otherwise nodes disagree about who owns what.
    const t1 = sampleTables();
    const t2 = sampleTables();
    t2.state_balances.reverse();
    t2.state_liquidity_pools.reverse();
    const a = buildSnapshot({ tables: t1, height: 358 });
    const b = buildSnapshot({ tables: t2, height: 358 });
    A(a.manifest.root === b.manifest.root, 'row order does not change the root');
    A(a.manifest.bodyHash === b.manifest.bodyHash, 'row order does not change the body hash');
}
{
    // Any change to state MUST move the root, or a tampered snapshot would pass.
    const base = buildSnapshot({ tables: sampleTables(), height: 358 });
    const t = sampleTables();
    t.state_balances[0].balance = 100.6;                    // one balance, tenth of a unit
    const changed = buildSnapshot({ tables: t, height: 358 });
    A(changed.manifest.root !== base.manifest.root, 'changing ONE balance changes the root');

    const extra = sampleTables();
    extra.state_balances.push({ address: 'mallory', token_symbol: 'SYR', balance: 1e9 });
    A(buildSnapshot({ tables: extra, height: 358 }).manifest.root !== base.manifest.root,
      'INSERTING a fake account changes the root');

    const removed = sampleTables();
    removed.state_balances.pop();
    A(buildSnapshot({ tables: removed, height: 358 }).manifest.root !== base.manifest.root,
      'DELETING an account changes the root');
}

// ── per-chunk verification: trust the root, not the source ───────────────────
{
    const s = buildSnapshot({ tables: sampleTables(), height: 358, chunkBytes: 64 });
    A(s.chunks.length > 1, 'a small chunk size splits the snapshot into several chunks');
    for (const c of s.chunks) {
        A(verifySnapshotChunk({ index: c.index, data: c.data, proof: chunkProof(s.chunks, c.index), root: s.manifest.root }),
          `chunk ${c.index} verifies against the snapshot root`);
    }

    // A peer altering a single byte must be caught.
    const tampered = Buffer.from(s.chunks[0].data);
    tampered[0] ^= 0xff;
    A(!verifySnapshotChunk({ index: 0, data: tampered, proof: chunkProof(s.chunks, 0), root: s.manifest.root }),
      'a TAMPERED chunk fails verification — a malicious peer cannot forge balances');
    A(!verifySnapshotChunk({ index: 0, data: s.chunks[0].data, proof: chunkProof(s.chunks, 0), root: 'ab'.repeat(32) }),
      'a chunk does not verify against the wrong root');
    A(!verifySnapshotChunk({ index: 1, data: s.chunks[0].data, proof: chunkProof(s.chunks, 1), root: s.manifest.root }),
      'a chunk replayed under a different index fails');
}

// ── reassembly ────────────────────────────────────────────────────────────────
{
    const s = buildSnapshot({ tables: sampleTables(), height: 358, chunkBytes: 100 });
    const parsed = parseSnapshot(s.chunks, s.manifest);
    A(parsed.height === 358, 'the parsed snapshot carries the height');
    A(parsed.tables.state_balances.length === 3, 'balances survive the round trip');
    A(parsed.tables.state_liquidity_pools.length === 2, 'liquidity pools survive the round trip');
    A(parsed.tables.orders.length === 1, 'orders survive the round trip');
    const alice = parsed.tables.state_balances.find(r => r.address === 'alice' && r.token_symbol === 'SYR');
    A(alice && alice.balance === 100.5, 'an exact balance survives the round trip');

    // Chunks may arrive from different peers in any order.
    const shuffled = s.chunks.slice().reverse();
    A(parseSnapshot(shuffled, s.manifest).tables.state_balances.length === 3,
      'chunks can arrive in ANY order — they are reassembled by index');
}
{
    // A partial snapshot means missing accounts. It must FAIL, never import silently.
    const s = buildSnapshot({ tables: sampleTables(), height: 358, chunkBytes: 100 });
    let threw = false;
    try { parseSnapshot(s.chunks.slice(1), s.manifest); } catch (e) { threw = true; }
    A(threw, 'a MISSING chunk aborts the import rather than losing accounts silently');

    threw = false;
    try { parseSnapshot(s.chunks, null); } catch (e) { threw = true; }
    A(threw, 'parsing without a manifest is refused');

    // Bytes that pass per-chunk proofs but assemble wrongly are caught by the body hash.
    threw = false;
    try {
        parseSnapshot(s.chunks, Object.assign({}, s.manifest, { bodyHash: 'ff'.repeat(32) }));
    } catch (e) { threw = true; }
    A(threw, 'an assembled body that does not match the manifest hash is refused');
}

// ── full verification: the data must reproduce the committed root ────────────
{
    const s = buildSnapshot({ tables: sampleTables(), height: 358 });
    const parsed = parseSnapshot(s.chunks, s.manifest);
    A(verifySnapshot({ tables: parsed.tables, manifest: s.manifest }),
      'parsed data reproduces the committed root');

    const forged = JSON.parse(JSON.stringify(parsed.tables));
    forged.state_balances.find(r => r.address === 'bob').balance = 999999;
    A(!verifySnapshot({ tables: forged, manifest: s.manifest }),
      'data with an inflated balance does NOT reproduce the root — the strongest check');
    A(!verifySnapshot({ tables: parsed.tables, manifest: null }), 'verification requires a manifest');
}

// ── degenerate input ──────────────────────────────────────────────────────────
{
    const empty = buildSnapshot({ tables: {}, height: 0 });
    A(empty.chunks.length === 1, 'an empty snapshot still produces one chunk');
    A(empty.manifest.root !== null, 'an empty snapshot still has a root');
    const parsed = parseSnapshot(empty.chunks, empty.manifest);
    A(SNAPSHOT_TABLES.every(t => Array.isArray(parsed.tables[t])),
      'every known table is present, even when empty');
    A(buildSnapshot({}).manifest.totalBytes === 0, 'no tables means no bytes');
}
{
    // Unknown tables are ignored rather than crashing an older node — a newer primary
    // adding a table must not break every node that has not been updated yet.
    const s = buildSnapshot({ tables: Object.assign(sampleTables(), { future_table: [{ x: 1 }] }), height: 1 });
    const parsed = parseSnapshot(s.chunks, s.manifest);
    A(!('future_table' in parsed.tables), 'an unknown table is ignored, not fatal');
    A(parsed.tables.state_balances.length === 3, 'known tables still import correctly');
}

// ── scale: a realistic snapshot chunks and verifies ──────────────────────────
{
    const big = { state_balances: [], state_liquidity_pools: [] };
    for (let i = 0; i < 4000; i++) {
        big.state_balances.push({ address: 'addr' + String(i).padStart(6, '0'), token_symbol: 'SYR', balance: i * 1.5 });
    }
    for (let i = 0; i < 8000; i++) {
        big.state_liquidity_pools.push({ token_symbol: 'T'+i, token_reserve: i, usd_reserve: i * 0.5 });
    }
    const s = buildSnapshot({ tables: big, height: 1000 });
    A(s.chunks.length > 1, 'a realistic snapshot spans multiple chunks');
    for (const c of s.chunks) {
        A(verifySnapshotChunk({ index: c.index, data: c.data, proof: chunkProof(s.chunks, c.index), root: s.manifest.root }),
          `large-snapshot chunk ${c.index} verifies`);
    }
    const parsed = parseSnapshot(s.chunks, s.manifest);
    A(parsed.tables.state_balances.length === 4000, 'all 4000 balances survive');
    A(parsed.tables.state_liquidity_pools.length === 8000, 'all 8000 pool rows survive');
    A(verifySnapshot({ tables: parsed.tables, manifest: s.manifest }), 'the large snapshot verifies end to end');
}

console.log('ALL ' + n + ' SNAPSHOT TESTS PASSED');
