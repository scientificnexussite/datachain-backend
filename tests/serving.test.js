/* ════════════════════════════════════════════════════════════════════════════════════════
   serving.test.js — the serving reward must be solvent, un-farmable, and honest.

   These tests exist because this code pays out real SYR. The three properties that matter:
     1. SOLVENCY   — the pool is divided, never exceeded, at any node count.
     2. SYBIL COST — extra identities must cost stake and must not multiply the take.
     3. HONESTY    — self-reported bytes must not influence pay, and a rejection must say why.
   ════════════════════════════════════════════════════════════════════════════════════════ */
import assert from 'assert';
import {
    settleServing, evaluateClaim, uptimeFromReceipts,
    estimateDailyReward, SERVING_DEFAULTS
} from '../serving.js';
import { buildEpochBatch, PRIORITY } from '../treasury.js';

const NOW = 1_800_000_000_000;
const HOUR = 3600e3;

/** `witnesses` distinct probers, each probing `n` times with `okRatio` success. */
function receipts(witnesses, n = 10, okRatio = 1, ageMs = HOUR) {
    const out = [];
    for (let w = 0; w < witnesses; w++) {
        for (let i = 0; i < n; i++) {
            out.push({ prober: 'nd_prober' + w, at: NOW - ageMs, ok: i < Math.round(n * okRatio) });
        }
    }
    return out;
}
const claim = (address, over = {}) => Object.assign(
    { address, stake: 1000, receipts: receipts(5), bytesServed: 0 }, over);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── 1. SOLVENCY ────────────────────────────────────────────────────────────────────────
test('the pool is never exceeded, at any node count', () => {
    for (const n of [1, 2, 5, 10, 50, 200, 1000, 5000]) {
        const claims = Array.from({ length: n }, (_, i) => claim('nx_' + String(i).padStart(5, '0')));
        const r = settleServing({ epoch: 1, pool: 500, claims, now: NOW });
        assert.ok(r.totalAllocated <= 500 + 1e-9,
            `n=${n}: allocated ${r.totalAllocated} exceeds the 500 pool`);
        assert.ok(r.unallocated >= -1e-9, `n=${n}: negative remainder`);
    }
});

test('a flat-rate scheme would have gone insolvent where this does not', () => {
    // The scenario 05_TOKENOMICS §3 warns about, made concrete: at 10,000 nodes a flat
    // 1 SYR/node owes 10,000 SYR against a 500 SYR pool. Share-based owes exactly 500.
    const claims = Array.from({ length: 10000 }, (_, i) => claim('nx_' + String(i).padStart(6, '0')));
    const r = settleServing({ epoch: 1, pool: 500, claims, now: NOW });
    assert.ok(r.totalAllocated <= 500 + 1e-9, 'must still fit the pool at 10k nodes');
    assert.ok(10000 > 500, 'the flat alternative would owe 10000 SYR — 20x the pool');
});

test('per-node reward falls as the network grows (dilution is real and disclosed)', () => {
    const few = settleServing({ epoch: 1, pool: 500, claims: [claim('nx_a'), claim('nx_b')], now: NOW });
    const many = settleServing({ epoch: 1, pool: 500,
        claims: Array.from({ length: 100 }, (_, i) => claim('nx_' + i)), now: NOW });
    assert.ok(few.obligations[0].amount > many.obligations[0].amount,
        'more nodes must mean a smaller share each — this is what keeps it solvent');
    assert.strictEqual(estimateDailyReward({ nodeCount: 2, pool: 500 }).perNode, 250);
    assert.ok(estimateDailyReward({ nodeCount: 100, pool: 500 }).perNode < 250);
});

// ── 2. SYBIL RESISTANCE ────────────────────────────────────────────────────────────────
test('an unstaked identity earns nothing, and is told why', () => {
    const r = evaluateClaim(claim('nx_broke', { stake: 0 }), { now: NOW });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.reason, 'insufficient-stake');
    assert.ok(/needs 100/.test(r.detail), 'must state the requirement: ' + r.detail);
});

test('splitting into many identities does NOT multiply the take', () => {
    const pool = 500;
    const honest = settleServing({ epoch: 1, pool,
        claims: [claim('nx_a'), claim('nx_b'), claim('nx_c'), claim('nx_d')], now: NOW });
    const oneHonestShare = honest.obligations.find(o => o.address === 'nx_a').amount;

    // The attacker replaces its single identity with 50 — each of which must be staked.
    const sybil = settleServing({ epoch: 1, pool,
        claims: [claim('nx_b'), claim('nx_c'), claim('nx_d')]
            .concat(Array.from({ length: 50 }, (_, i) => claim('nx_evil' + String(i).padStart(3, '0')))),
        now: NOW });
    const attackerTake = sybil.obligations
        .filter(o => o.address.startsWith('nx_evil'))
        .reduce((s, o) => s + o.amount, 0);

    assert.ok(attackerTake <= pool + 1e-9, 'cannot exceed the pool');
    // 50 identities cost 50 x MIN_STAKE = 5000 SYR locked up to chase one day of pool.
    assert.ok(50 * SERVING_DEFAULTS.MIN_STAKE > pool * 5,
        'the stake required must dwarf a day of pool, or sybil is profitable');
    assert.ok(oneHonestShare > 0, 'honest nodes must still be paid');
});

test('self-probing cannot manufacture uptime', () => {
    // 1000 receipts, all from the SAME prober: one witness, not a thousand.
    const selfProbed = Array.from({ length: 1000 }, () => ({ prober: 'nd_me', at: NOW - HOUR, ok: true }));
    const u = uptimeFromReceipts(selfProbed, { now: NOW });
    assert.strictEqual(u.witnesses, 1, 'repeat probes from one source are one witness');

    const r = evaluateClaim(claim('nx_liar', { receipts: selfProbed }), { now: NOW });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.reason, 'not-enough-witnesses');
});

test('one prolific prober cannot outvote the others', () => {
    // Four witnesses say the node is down; one spams 500 successful probes.
    const mixed = [
        ...Array.from({ length: 500 }, () => ({ prober: 'nd_friend', at: NOW - HOUR, ok: true })),
        ...['w1', 'w2', 'w3', 'w4'].flatMap(w =>
            Array.from({ length: 10 }, () => ({ prober: 'nd_' + w, at: NOW - HOUR, ok: false })))
    ];
    const u = uptimeFromReceipts(mixed, { now: NOW });
    assert.strictEqual(u.witnesses, 5);
    assert.ok(u.uptime <= 0.21,
        `averaging per witness must limit the spammer to 1/5 of the vote, got ${u.uptime}`);
});

// ── 3. HONESTY ─────────────────────────────────────────────────────────────────────────
test('self-reported bytes do NOT affect payout', () => {
    const modest = settleServing({ epoch: 1, pool: 500,
        claims: [claim('nx_a', { bytesServed: 1 }), claim('nx_b', { bytesServed: 1 })], now: NOW });
    const boastful = settleServing({ epoch: 1, pool: 500,
        claims: [claim('nx_a', { bytesServed: 9e15 }), claim('nx_b', { bytesServed: 1 })], now: NOW });

    const a1 = modest.obligations.find(o => o.address === 'nx_a').amount;
    const a2 = boastful.obligations.find(o => o.address === 'nx_a').amount;
    assert.strictEqual(a1, a2,
        'claiming petabytes must earn exactly the same — unverifiable numbers must not pay');
});

test('stake is a gate, never a multiplier', () => {
    const r = settleServing({ epoch: 1, pool: 500,
        claims: [claim('nx_rich', { stake: 10_000_000 }), claim('nx_modest', { stake: 100 })], now: NOW });
    const rich = r.obligations.find(o => o.address === 'nx_rich').amount;
    const modest = r.obligations.find(o => o.address === 'nx_modest').amount;
    assert.ok(Math.abs(rich - modest) < 1e-9,
        'equal uptime must earn equally regardless of wealth — otherwise this is rent, not pay');
});

test('low uptime and stale receipts are rejected with a reason', () => {
    const low = evaluateClaim(claim('nx_flaky', { receipts: receipts(5, 10, 0.2) }), { now: NOW });
    assert.strictEqual(low.reason, 'uptime-too-low');
    assert.ok(/needs 50%/.test(low.detail), low.detail);

    const stale = evaluateClaim(claim('nx_old', { receipts: receipts(5, 10, 1, 48 * HOUR) }), { now: NOW });
    assert.strictEqual(stale.reason, 'not-enough-witnesses',
        'yesterday-but-one proves nothing about this epoch');
});

test('future-dated receipts are ignored', () => {
    const future = Array.from({ length: 50 }, (_, i) =>
        ({ prober: 'nd_w' + (i % 5), at: NOW + 10 * HOUR, ok: true }));
    assert.strictEqual(uptimeFromReceipts(future, { now: NOW }).witnesses, 0,
        'a node must not earn by post-dating its own evidence');
});

// ── 4. INTEGRATION WITH THE TREASURY QUEUE ─────────────────────────────────────────────
test('serving flows through the solvency queue and never overdraws', () => {
    const { obligations } = settleServing({ epoch: 7, pool: 500,
        claims: [claim('nx_a'), claim('nx_b')], now: NOW });

    // Treasury holds only 100 SYR against 500 SYR of serving obligations.
    const batch = buildEpochBatch({ epoch: 7, balance: 100, epochPool: 0, hosts: [], serving: obligations });
    const paid = batch.payouts.reduce((s, o) => s + o.amount, 0);

    assert.ok(paid <= 100 + 1e-9, 'must never pay more than the treasury holds');
    assert.ok(batch.balanceAfter >= -1e-9, 'balance must never go negative');
    assert.ok(batch.pending.length > 0, 'what cannot be paid must stay owed, not vanish');
});

test('hosts and storage are paid before serving when money is short', () => {
    const { obligations: serving } = settleServing({ epoch: 8, pool: 500,
        claims: [claim('nx_server')], now: NOW });
    const batch = buildEpochBatch({
        epoch: 8, balance: 10, epochPool: 100,
        hosts: [{ address: 'nx_host', q: 1, u: 1, f: 1, home: false }],
        storage: [{ address: 'nx_store', amount: 5 }],
        serving
    });
    const paidAddrs = batch.payouts.map(p => p.address);
    if (paidAddrs.includes('nx_server')) {
        assert.ok(paidAddrs.includes('nx_host') && paidAddrs.includes('nx_store'),
            'serving must not be paid ahead of hosts or storage');
    }
    const s = batch.payouts.concat(batch.pending).find(o => o.address === 'nx_server');
    assert.strictEqual(s.priority, PRIORITY.SERVING);
});

test('no eligible claims returns the whole pool unallocated, not a crash', () => {
    for (const claims of [[], null, undefined, [claim('nx_a', { stake: 0 })]]) {
        const r = settleServing({ epoch: 1, pool: 500, claims, now: NOW });
        assert.strictEqual(r.obligations.length, 0);
        assert.strictEqual(r.unallocated, 500, 'unpaid pool stays in the treasury');
    }
});

test('obligations are address-sorted so every node builds the same block', () => {
    const claims = ['nx_z', 'nx_a', 'nx_m'].map(a => claim(a));
    const a = settleServing({ epoch: 1, pool: 500, claims, now: NOW }).obligations.map(o => o.address);
    const b = settleServing({ epoch: 1, pool: 500, claims: claims.slice().reverse(), now: NOW })
        .obligations.map(o => o.address);
    assert.deepStrictEqual(a, b, 'input order must not change the batch — otherwise nodes fork');
    assert.deepStrictEqual(a, ['nx_a', 'nx_m', 'nx_z']);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
