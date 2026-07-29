/* ════════════════════════════════════════════════════════════════════════════════
   dispatch.test.js — F17 random beacon + F14 decentralized assignment.

   Together these remove the central dispatcher, so the properties under test are
   adversarial rather than arithmetic: can a withholding member steer the beacon, can a
   powerful host guarantee itself a shard, and does every node derive the SAME answer?
   A failure in any of those is a consensus split or a targeted-attack vector, not a bug.
   ════════════════════════════════════════════════════════════════════════════════ */
import {
    newReveal, commitment, verifyCommitment, mixReveals, delay,
    computeBeacon, verifyBeacon, BEACON_DEFAULTS
} from '../beacon.js';
import {
    drawUnit, hostWeight, selectionKey, assignShard, assignEpoch, verifyAssignment
} from '../assignment.js';
import crypto from 'crypto';

let n = 0;
const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };
const FAST = 200;                                   // keep the delay cheap in tests

// ── F17: commit / reveal ──────────────────────────────────────────────────────
{
    const r = newReveal();
    A(/^[0-9a-f]{64}$/.test(r), 'a reveal is 32 bytes of hex');
    A(newReveal() !== newReveal(), 'reveals are not repeated');

    const c = commitment(r);
    A(/^[0-9a-f]{64}$/.test(c), 'a commitment is a 32-byte hash');
    A(verifyCommitment(c, r), 'the matching reveal opens the commitment');
    A(!verifyCommitment(c, newReveal()), 'a DIFFERENT reveal cannot open the commitment');
    A(commitment(r) === c, 'commitment is deterministic');

    for (const bad of ['', 'xyz', null, undefined, 'ab'.repeat(10)]) {
        let threw = false;
        try { commitment(bad); } catch (e) { threw = true; }
        A(threw, 'a malformed reveal is rejected: ' + String(bad).slice(0, 12));
    }
    A(!verifyCommitment('nothex', r), 'a malformed commitment never verifies');
}

// ── F17: XOR mixing ───────────────────────────────────────────────────────────
{
    const a = 'aa'.repeat(32), b = '55'.repeat(32);
    A(mixReveals([a, b]).mixed === 'ff'.repeat(32), 'reveals XOR together');
    A(mixReveals([a, b]).mixed === mixReveals([b, a]).mixed,
      'XOR is ORDER-INDEPENDENT — nodes see reveals in different orders and must still agree');
    A(mixReveals([a, a]).mixed === '00'.repeat(32), 'identical reveals cancel, as XOR requires');
    A(mixReveals([]).used === 0, 'no reveals contribute nothing');
    A(mixReveals(['bad', a]).used === 1, 'malformed reveals are skipped, valid ones still count');
}

// ── F17: the delay function ───────────────────────────────────────────────────
{
    const seed = '11'.repeat(32);
    const d1 = delay(seed, 100), d2 = delay(seed, 100);
    A(d1 === d2, 'the delay function is deterministic');
    A(delay(seed, 100) !== delay(seed, 101), 'iteration count changes the output');
    A(delay(seed, 100) !== delay('22'.repeat(32), 100), 'a different seed gives a different output');
    A(/^[0-9a-f]{64}$/.test(d1), 'the delay output is a 32-byte hash');
    A(delay(seed, 0) === delay(seed, 1), 'iterations below one are clamped to one');
    // Sequential cost must actually grow — that is the security property.
    const t0 = Date.now(); delay(seed, 20000); const slow = Date.now() - t0;
    const t1 = Date.now(); delay(seed, 200); const fast = Date.now() - t1;
    A(slow >= fast, 'more iterations cost more time (evaluation is sequential)');
}

// ── F17: the whole protocol ───────────────────────────────────────────────────
{
    const members = ['alice', 'bob', 'carol'];
    const secrets = Object.fromEntries(members.map(m => [m, newReveal()]));
    const commits = members.map(id => ({ id, commit: commitment(secrets[id]) }));
    const reveals = members.map(id => ({ id, reveal: secrets[id] }));

    const r = computeBeacon({ commits, reveals, iterations: FAST });
    A(/^[0-9a-f]{64}$/.test(r.beacon), 'a beacon is produced');
    A(r.contributors.length === 3 && r.missing.length === 0 && r.invalid.length === 0,
      'all honest members are counted as contributors');
    A(verifyBeacon({ commits, reveals, iterations: FAST, beacon: r.beacon }),
      'a published beacon can be re-derived and verified');
    A(!verifyBeacon({ commits, reveals, iterations: FAST, beacon: 'ff'.repeat(32) }),
      'a forged beacon does not verify');

    // Order independence across the whole protocol, not just the XOR.
    const shuffled = computeBeacon({
        commits: commits.slice().reverse(), reveals: reveals.slice().reverse(), iterations: FAST });
    A(shuffled.beacon === r.beacon, 'the beacon is identical regardless of submission order');
    A(JSON.stringify(shuffled.contributors) === JSON.stringify(r.contributors),
      'contributor lists are identically ordered on every node');
}

// ── F17: the attacks this exists to stop ──────────────────────────────────────
{
    const members = ['honest1', 'honest2', 'withholder'];
    const secrets = Object.fromEntries(members.map(m => [m, newReveal()]));
    const commits = members.map(id => ({ id, commit: commitment(secrets[id]) }));

    // A member who commits then WITHHOLDS is excluded and named for slashing.
    const partial = computeBeacon({
        commits,
        reveals: [{ id: 'honest1', reveal: secrets.honest1 }, { id: 'honest2', reveal: secrets.honest2 }],
        iterations: FAST
    });
    A(partial.beacon !== null, 'the beacon still forms when one member withholds');
    A(partial.missing.includes('withholder'), 'the withholder is reported for slashing');
    A(!partial.contributors.includes('withholder'), 'a withholder contributes no randomness');

    // Revealing something that does not match the commitment is likewise rejected.
    const lying = computeBeacon({
        commits,
        reveals: members.map(id => ({ id, reveal: id === 'withholder' ? newReveal() : secrets[id] })),
        iterations: FAST
    });
    A(lying.invalid.includes('withholder'), 'a reveal that does not match its commit is rejected');
    A(lying.contributors.length === 2, 'only members who opened their commitment honestly count');

    // Submitting several reveals must not let a member choose afterwards.
    const doubled = computeBeacon({
        commits,
        reveals: [
            { id: 'honest1', reveal: secrets.honest1 },
            { id: 'honest1', reveal: newReveal() },
            { id: 'honest2', reveal: secrets.honest2 }
        ],
        iterations: FAST
    });
    A(doubled.contributors.filter(c => c === 'honest1').length === 1,
      'only a member FIRST reveal counts — no picking between submissions');

    // ONE honest contributor is enough to randomise the result.
    const soloA = computeBeacon({ commits: [commits[0]], reveals: [{ id: 'honest1', reveal: secrets.honest1 }], iterations: FAST });
    const other = newReveal();
    const soloB = computeBeacon({ commits: [{ id: 'honest1', commit: commitment(other) }], reveals: [{ id: 'honest1', reveal: other }], iterations: FAST });
    A(soloA.beacon !== soloB.beacon, 'a single honest reveal still determines a distinct beacon');

    // No valid reveals at all -> NO beacon. A value derived from nothing would be a fixed,
    // fully predictable constant that still looks legitimate.
    const none = computeBeacon({ commits, reveals: [], iterations: FAST });
    A(none.beacon === null, 'with no valid reveals there is NO beacon, not a predictable one');
    A(none.missing.length === 3, 'every non-revealer is listed');
    A(computeBeacon({}).beacon === null, 'no arguments produces no beacon');
}

// ── F14: the draw ─────────────────────────────────────────────────────────────
{
    const b = 'ab'.repeat(32);
    const u = drawUnit(b, 'shard-1', 'host-a');
    A(u >= 0 && u < 1, 'a draw is in [0,1)');
    A(drawUnit(b, 'shard-1', 'host-a') === u, 'the draw is deterministic');
    A(drawUnit(b, 'shard-2', 'host-a') !== u, 'a different shard gives a different draw');
    A(drawUnit(b, 'shard-1', 'host-b') !== u, 'a different host gives a different draw');
    A(drawUnit('cd'.repeat(32), 'shard-1', 'host-a') !== u, 'a different beacon gives a different draw');

    A(hostWeight({ computeClass: 4, q: 0.5 }) === 2, 'weight = compute_class * q');
    A(hostWeight({ computeClass: 4, q: 2 }) === 4, 'q is capped at 1');
    A(hostWeight({ computeClass: 0, q: 1 }) === 0, 'zero compute class cannot be selected');
    A(hostWeight({ computeClass: 4, q: 0 }) === 0, 'zero honesty cannot be selected');
    A(hostWeight({ computeClass: -1, q: 1 }) === 0, 'a negative weight cannot be selected');
    A(hostWeight(null) === 0, 'a missing host has no weight');

    A(selectionKey(0.5, 0) === -1, 'an ineligible host ranks below everyone');
    A(selectionKey(0.5, 4) > selectionKey(0.5, 1), 'on the SAME draw, a heavier host scores higher');
}

// ── F14: assignment ───────────────────────────────────────────────────────────
{
    const beacon = 'ab'.repeat(32);
    const hosts = [];
    for (let i = 0; i < 20; i++) hosts.push({ id: 'h' + String(i).padStart(2, '0'), computeClass: 1, q: 1 });

    const a1 = assignShard({ beacon, shardId: 's1', hosts, r: 5 });
    A(a1.assigned.length === 5, 'exactly r replicas are assigned');
    A(new Set(a1.assigned).size === 5, 'no host is assigned twice to one shard');

    const a2 = assignShard({ beacon, shardId: 's1', hosts: hosts.slice().reverse(), r: 5 });
    A(JSON.stringify(a1.assigned) === JSON.stringify(a2.assigned),
      'every node derives the SAME assignment regardless of host order');

    const other = assignShard({ beacon, shardId: 's2', hosts, r: 5 });
    A(JSON.stringify(other.assigned) !== JSON.stringify(a1.assigned),
      'different shards get different replica sets (anti-collusion, 04)');

    const nextEpoch = assignShard({ beacon: 'cd'.repeat(32), shardId: 's1', hosts, r: 5 });
    A(JSON.stringify(nextEpoch.assigned) !== JSON.stringify(a1.assigned),
      'a new beacon reshuffles assignments, so nobody can camp a shard');

    A(verifyAssignment({ beacon, shardId: 's1', hosts, r: 5, assigned: a1.assigned }),
      'a published assignment verifies');
    A(!verifyAssignment({ beacon, shardId: 's1', hosts, r: 5, assigned: ['h00', 'h01', 'h02', 'h03', 'h04'] }),
      'a cherry-picked assignment does NOT verify');

    // No beacon -> no assignment. Falling back to something guessable would defeat F17.
    A(assignShard({ shardId: 's1', hosts, r: 5 }).assigned.length === 0,
      'without a beacon there is no assignment');
    A(assignShard({ beacon, hosts, r: 5 }).assigned.length === 0, 'without a shard id there is no assignment');
    A(assignShard({ beacon, shardId: 's1', hosts: [], r: 5 }).assigned.length === 0, 'no hosts -> no assignment');
    A(assignShard({ beacon, shardId: 's1', hosts, r: 0 }).assigned.length === 0, 'r=0 assigns nobody');
    A(assignShard({ beacon, shardId: 's1', hosts, r: 999 }).assigned.length === 20,
      'asking for more replicas than hosts assigns everyone available, not undefined entries');

    // Ineligible hosts are never selected.
    const withDead = hosts.concat([
        { id: 'banned', computeClass: 1000, q: 0 },
        { id: 'idle', computeClass: 0, q: 1 }
    ]);
    const a3 = assignShard({ beacon, shardId: 's1', hosts: withDead, r: 22 });
    A(!a3.assigned.includes('banned'), 'a host with zero honesty is never assigned, however powerful');
    A(!a3.assigned.includes('idle'), 'a host with no compute class is never assigned');

    // A duplicated id must not get two chances.
    const dup = assignShard({ beacon, shardId: 's1', hosts: hosts.concat([hosts[0]]), r: 5 });
    A(new Set(dup.assigned).size === dup.assigned.length, 'a duplicated host cannot occupy two replica slots');
}

// ── F14: weighting must bias WITHOUT guaranteeing ─────────────────────────────
{
    const hosts = [{ id: 'whale', computeClass: 100, q: 1 }];
    for (let i = 0; i < 30; i++) hosts.push({ id: 'small' + String(i).padStart(2, '0'), computeClass: 1, q: 1 });

    let whaleWins = 0;
    const TRIALS = 300;
    for (let i = 0; i < TRIALS; i++) {
        const beacon = crypto.createHash('sha256').update('epoch' + i).digest('hex');
        if (assignShard({ beacon, shardId: 's1', hosts, r: 3 }).assigned.includes('whale')) whaleWins++;
    }
    A(whaleWins > TRIALS * 0.5, 'a much stronger host is selected far more often (weighting works)');
    A(whaleWins < TRIALS, 'a stronger host is NOT guaranteed every shard — selection stays unpredictable');
}
{
    // Across many shards the work spreads out rather than landing on a handful of hosts.
    const beacon = 'ef'.repeat(32);
    const hosts = [];
    for (let i = 0; i < 30; i++) hosts.push({ id: 'h' + String(i).padStart(2, '0'), computeClass: 1, q: 1 });
    const shards = [];
    for (let i = 0; i < 60; i++) shards.push('shard-' + i);
    const { assignments, unassigned } = assignEpoch({ beacon, shards, hosts, r: 5 });
    A(Object.keys(assignments).length === 60, 'every shard is assigned');
    A(unassigned.length === 0, 'no shard is left short of its replica count');
    const counts = {};
    for (const list of Object.values(assignments)) for (const id of list) counts[id] = (counts[id] || 0) + 1;
    A(Object.keys(counts).length >= 25, 'work spreads across most hosts rather than a few');
}
{
    // Too few eligible hosts BREAKS F6's Byzantine-majority guarantee — say so.
    const beacon = 'ef'.repeat(32);
    const { unassigned } = assignEpoch({
        beacon, shards: ['a', 'b'],
        hosts: [{ id: 'only1', computeClass: 1, q: 1 }, { id: 'only2', computeClass: 1, q: 1 }], r: 5 });
    A(unassigned.length === 2, 'shards that cannot reach r replicas are reported, not silently weakened');
}

// ── end to end: beacon -> assignment ──────────────────────────────────────────
{
    const members = ['m1', 'm2', 'm3'];
    const secrets = Object.fromEntries(members.map(m => [m, newReveal()]));
    const commits = members.map(id => ({ id, commit: commitment(secrets[id]) }));
    const reveals = members.map(id => ({ id, reveal: secrets[id] }));
    const { beacon } = computeBeacon({ commits, reveals, iterations: FAST });

    const hosts = [];
    for (let i = 0; i < 12; i++) hosts.push({ id: 'host' + i, computeClass: 1 + (i % 3), q: 0.9 });
    const { assigned } = assignShard({ beacon, shardId: 'shard-7', hosts, r: 5 });
    A(assigned.length === 5, 'a committee beacon drives a real assignment');
    A(verifyAssignment({ beacon, shardId: 'shard-7', hosts, r: 5, assigned }),
      'the full chain beacon -> assignment is independently verifiable');
}

console.log('ALL ' + n + ' DISPATCH TESTS PASSED');
