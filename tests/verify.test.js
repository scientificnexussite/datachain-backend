/* ════════════════════════════════════════════════════════════════════════════════
   verify.test.js — F6 redundancy consensus + F16 verified-work credit.

   These decide who gets PAID out of the AI treasury, so the properties that matter are
   adversarial, not just arithmetic: a minority must never win a shard, a lazy host must
   never earn, a whale must never out-claim its hardware, and every node must derive an
   IDENTICAL receipt set from the same submissions.
   ════════════════════════════════════════════════════════════════════════════════ */
import {
    decideShard, creditShard, applyBenchmarkCap, buildReceipts,
    resultDistance, poisonProbability, replicasFor, stakeIsSufficient, VERIFY_DEFAULTS
} from '../verify.js';

let n = 0;
const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sub = (address, result) => ({ address, result });

// ── result distance ───────────────────────────────────────────────────────────
A(resultDistance(1, 1) === 0, 'identical scalars are distance 0');
A(near(resultDistance(1, 1.5), 0.5), 'scalar distance is absolute difference');
A(resultDistance([1, 2], [1, 2]) === 0, 'identical vectors are distance 0');
A(near(resultDistance([1, 2], [1, 2.5]), 0.5), 'vector distance is the worst component');
A(resultDistance([1, 2], [1]) === Infinity, 'shape mismatch can never agree');
A(resultDistance([], []) === Infinity, 'empty vectors are not a valid agreement');
A(resultDistance('abc', 'abc') === 0, 'identical hashes agree');
A(resultDistance('abc', 'abd') === Infinity, 'different hashes never agree');
A(resultDistance(1, 'a') === Infinity, 'mixed types never agree');
A(resultDistance(NaN, NaN) === Infinity, 'NaN never agrees with anything');
A(resultDistance(null, null) === Infinity, 'null never agrees');

// ── F6: honest majority wins ──────────────────────────────────────────────────
{
    const d = decideShard({ submissions: [
        sub('a', 10), sub('b', 10), sub('c', 10), sub('d', 99), sub('e', 99)
    ]});
    A(d.accepted, 'a 3-of-5 majority is accepted');
    A(d.required === 3, 'required quorum is floor(r/2)+1');
    A(d.quorum === 3, 'quorum counts the agreeing cluster');
    A(JSON.stringify(d.agreed) === JSON.stringify(['a', 'b', 'c']), 'the majority is credited');
    A(JSON.stringify(d.dissented) === JSON.stringify(['d', 'e']), 'the minority is recorded as dissenting');
}

// ── F6: a MINORITY MUST NEVER WIN (the core security property) ────────────────
{
    const d = decideShard({ submissions: [
        sub('honest1', 10), sub('honest2', 10), sub('honest3', 10),
        sub('evil1', 66), sub('evil2', 66)
    ]});
    A(d.accepted && !d.agreed.includes('evil1') && !d.agreed.includes('evil2'),
      'a 2-of-5 attacker cluster cannot win the shard');
}
{
    // Attacker holds a majority: F6 openly concedes this case (that is WHY r matters).
    const d = decideShard({ submissions: [
        sub('evil1', 66), sub('evil2', 66), sub('evil3', 66), sub('honest', 10)
    ]});
    A(d.accepted && d.agreed.length === 3 && !d.agreed.includes('honest'),
      'a true majority of colluders does win — the reason r is chosen from p (F6)');
}

// ── F6: no majority -> nobody wins ────────────────────────────────────────────
{
    const d = decideShard({ submissions: [sub('a', 1), sub('b', 2), sub('c', 3), sub('d', 4)] });
    A(!d.accepted, 'a fully split shard is rejected');
    A(d.split === true, 'a split shard is flagged as inconclusive');
    A(d.agreed.length === 0, 'nobody is credited on a split');
}
{
    const d = decideShard({ submissions: [sub('a', 1), sub('b', 1), sub('c', 9), sub('d', 9)] });
    A(!d.accepted, 'an exact 2-2 tie has no majority and is rejected');
}

// ── F6: eps tolerance ─────────────────────────────────────────────────────────
{
    const d = decideShard({ submissions: [sub('a', 1.0), sub('b', 1.0000001), sub('c', 5)], eps: 1e-6 });
    A(d.accepted && d.quorum === 2, 'results within eps count as agreeing');
}
{
    const d = decideShard({ submissions: [sub('a', 1.0), sub('b', 1.1), sub('c', 5)], eps: 1e-6 });
    A(!d.accepted, 'results outside eps do not agree');
}
{
    const d = decideShard({ submissions: [sub('a', [1, 2, 3]), sub('b', [1, 2, 3]), sub('c', [1, 2, 9])] });
    A(d.accepted && JSON.stringify(d.agreed) === JSON.stringify(['a', 'b']), 'vector results cluster correctly');
}

// ── F6: a host cannot vote twice ──────────────────────────────────────────────
{
    const d = decideShard({ submissions: [
        sub('sybil', 66), sub('sybil', 66), sub('sybil', 66), sub('honest1', 10), sub('honest2', 10)
    ]});
    A(d.quorum === 2 && d.agreed.includes('honest1'),
      'duplicate submissions from one address are collapsed, so ballot-stuffing fails');
}

// ── determinism: order in must never change the outcome ───────────────────────
{
    const subs = [sub('zz', 10), sub('aa', 10), sub('mm', 99), sub('bb', 10)];
    const d1 = decideShard({ submissions: subs });
    const d2 = decideShard({ submissions: subs.slice().reverse() });
    A(JSON.stringify(d1) === JSON.stringify(d2), 'the decision is identical regardless of submission order');
    A(JSON.stringify(d1.agreed) === JSON.stringify(['aa', 'bb', 'zz']), 'agreed list is address-sorted');
}

// ── degenerate input ──────────────────────────────────────────────────────────
A(decideShard({ submissions: [] }).accepted === false, 'an empty shard is not accepted');
A(decideShard({}).accepted === false, 'missing submissions are safe');
A(decideShard({ submissions: [sub('solo', 5)] }).accepted === true, 'a single replica trivially agrees with itself');
A(decideShard({ submissions: [{ result: 1 }, sub('a', 1)] }).quorum === 1, 'submissions without an address are ignored');

// ── F16: only verified work earns ─────────────────────────────────────────────
{
    const ledger = new Map();
    const d = decideShard({ submissions: [sub('a', 10), sub('b', 10), sub('c', 99)] });
    creditShard({ decision: d, shardCost: 1000, ledger });
    A(ledger.get('a').f === 1000 && ledger.get('b').f === 1000, 'agreeing hosts are credited the shard cost');
    A(ledger.get('c').f === 0, 'a WRONG host earns nothing');
    A(ledger.get('a').q > VERIFY_DEFAULTS.Q_INIT, 'honesty rises for agreeing hosts');
    A(ledger.get('c').q < VERIFY_DEFAULTS.Q_INIT, 'honesty falls for dissenting hosts');
}
{
    const ledger = new Map();
    const d = decideShard({ submissions: [sub('a', 1), sub('b', 2), sub('c', 3)] });
    creditShard({ decision: d, shardCost: 1000, ledger });
    A(ledger.get('a').f === 0 && ledger.get('b').f === 0, 'a split shard credits nobody');
    A(ledger.get('a').q === VERIFY_DEFAULTS.Q_INIT,
      'a split shard does NOT punish honesty — otherwise one attacker could force splits to damage everyone');
}
{
    const ledger = new Map();
    const d = decideShard({ submissions: [sub('a', 10), sub('b', 10)] });
    creditShard({ decision: d, shardCost: 0, ledger });
    A(ledger.get('a').f === 0, 'a zero-cost shard credits nothing');
    creditShard({ decision: d, shardCost: -50, ledger });
    A(ledger.get('a').f === 0, 'a negative shard cost cannot mint credit');
}

// ── honesty asymmetry: cheating must not pay ──────────────────────────────────
{
    // Honesty moves multiplicatively toward its bound, so the property to check is the
    // SEPARATION over a realistic epoch (many shards/day), not a single-step magnitude.
    const ledger = new Map();
    const good = decideShard({ submissions: [sub('x', 10), sub('y', 10), sub('z', 99)] });
    for (let i = 0; i < 5; i++) creditShard({ decision: good, shardCost: 10, ledger });
    A(ledger.get('x').q > ledger.get('z').q, 'an honest host outranks a cheat immediately');
    A(ledger.get('z').q < VERIFY_DEFAULTS.Q_INIT * 0.5, 'five dissents already halve honesty');

    for (let i = 0; i < 45; i++) creditShard({ decision: good, shardCost: 10, ledger });
    const honestQ = ledger.get('x').q, cheatQ = ledger.get('z').q;
    A(honestQ > 0.8, 'a consistently honest host climbs toward full trust');
    A(cheatQ < 0.001, 'sustained dissent collapses honesty to near zero');
    A(honestQ / Math.max(cheatQ, 1e-12) > 100,
      'over an epoch an honest host carries >100x the weight of a cheat (F3 share is linear in q)');

    // Alternating cheat/behave must end up WORSE than never cheating.
    const alt = new Map();
    for (let i = 0; i < 10; i++) {
        const dec = (i % 2 === 0)
            ? decideShard({ submissions: [sub('flip', 10), sub('p', 10), sub('q', 10)] })
            : decideShard({ submissions: [sub('flip', 99), sub('p', 10), sub('q', 10)] });
        creditShard({ decision: dec, shardCost: 10, ledger: alt });
    }
    A(alt.get('flip').q < alt.get('p').q, 'alternating cheat/behave is punished, not laundered');
}
{
    // Recovery must be possible - a compromised-then-fixed host is not banned forever.
    const ledger = new Map();
    const bad = decideShard({ submissions: [sub('r', 99), sub('s', 10), sub('t', 10)] });
    creditShard({ decision: bad, shardCost: 10, ledger });
    const low = ledger.get('r').q;
    const good = decideShard({ submissions: [sub('r', 10), sub('s', 10), sub('t', 10)] });
    for (let i = 0; i < 200; i++) creditShard({ decision: good, shardCost: 10, ledger });
    A(ledger.get('r').q > low, 'a reformed host can recover honesty');
    A(ledger.get('r').q <= 1, 'honesty never exceeds 1');
}

// ── F16: benchmark cap ────────────────────────────────────────────────────────
{
    const under = applyBenchmarkCap(100, 1000, 1.25);
    A(under.credited === 100 && !under.capped, 'a plausible claim passes uncapped');

    const over = applyBenchmarkCap(10000, 1000, 1.25);
    A(over.credited === 1250 && over.capped, 'an impossible claim is capped at kappa * B');
    A(over.withheld === 8750, 'the excess is withheld and reported, not silently dropped');

    const none = applyBenchmarkCap(500, 0);
    A(none.credited === 500 && none.unbenchmarked,
      'with no benchmark the claim is credited but flagged, rather than capped at an invented limit');
    A(applyBenchmarkCap(-5, 100).credited === 0, 'a negative claim credits nothing');
    A(applyBenchmarkCap(NaN, 100).credited === 0, 'NaN credits nothing');
}

// ── end to end: shards in, F3-ready receipts out ──────────────────────────────
{
    const shards = [
        { id: 's1', shardCost: 100, submissions: [sub('h1', 5), sub('h2', 5), sub('h3', 5)] },
        { id: 's2', shardCost: 100, submissions: [sub('h1', 7), sub('h2', 7), sub('h3', 999)] },
        { id: 's3', shardCost: 100, submissions: [sub('h1', 1), sub('h2', 2), sub('h3', 3)] }  // split
    ];
    const hosts = {
        h1: { benchmark: 1000, uptime: 0.9, home: true },
        h2: { benchmark: 1000, uptime: 0.8, home: false },
        h3: { benchmark: 1000, uptime: 1.0, home: false }
    };
    const { receipts, stats } = buildReceipts({ shards, hosts });

    A(stats.acceptedShards === 2 && stats.splitShards === 1, 'shard outcomes are tallied');
    const by = Object.fromEntries(receipts.map(r => [r.address, r]));
    A(by.h1.f === 200 && by.h2.f === 200, 'hosts are credited for both accepted shards');
    A(by.h3.f === 100, 'the host that was wrong once is credited only for the shard it got right');
    A(by.h1.u === 0.9 && by.h1.home === true, 'uptime and home status flow into the receipt');
    A(by.h3.q < by.h1.q, 'the dissenting host carries a lower honesty score');
    A(receipts.every(r => r.f > 0 && r.q >= 0 && r.q <= 1 && r.u >= 0 && r.u <= 1),
      'receipts are exactly F3 inputs and in range');
    A(JSON.stringify(receipts.map(r => r.address)) === JSON.stringify(['h1', 'h2', 'h3']),
      'receipts are address-sorted for byte-identical batches');
}
{
    // Shard order must not change receipts — every node may see them in any order.
    const shards = [
        { id: 'b', shardCost: 50, submissions: [sub('x', 1), sub('y', 1)] },
        { id: 'a', shardCost: 70, submissions: [sub('x', 2), sub('y', 2)] }
    ];
    const hosts = { x: { benchmark: 1e9, uptime: 1 }, y: { benchmark: 1e9, uptime: 1 } };
    const r1 = buildReceipts({ shards, hosts });
    const r2 = buildReceipts({ shards: shards.slice().reverse(), hosts });
    A(JSON.stringify(r1.receipts) === JSON.stringify(r2.receipts), 'receipts are identical regardless of shard order');
    A(r1.receipts[0].f === 120, 'credit accumulates across shards');
}
{
    // A host claiming beyond its hardware is capped and surfaced for audit.
    const shards = [];
    for (let i = 0; i < 50; i++) {
        shards.push({ id: 's' + i, shardCost: 100, submissions: [sub('whale', 1), sub('peer', 1)] });
    }
    const { receipts, audit } = buildReceipts({
        shards, hosts: { whale: { benchmark: 100, uptime: 1 }, peer: { benchmark: 1e9, uptime: 1 } }
    });
    const whale = receipts.find(r => r.address === 'whale');
    A(whale.f === 125, 'an over-claiming host is capped at kappa * benchmark');
    A(audit.some(a => a.address === 'whale' && a.withheld > 0), 'the over-claim is raised for audit');
}
A(buildReceipts({}).receipts.length === 0, 'no shards -> no receipts');
A(buildReceipts({ shards: [null, undefined] }).receipts.length === 0, 'junk shards are ignored');
{
    const { receipts } = buildReceipts({
        shards: [{ id: 'z', shardCost: 10, submissions: [sub('a', 1), sub('b', 9), sub('c', 5)] }],
        hosts: { a: { uptime: 1 } }
    });
    A(receipts.length === 0, 'a host with no verified work produces no receipt');
}

// ── F6 calibration helpers ────────────────────────────────────────────────────
A(near(poisonProbability(0.2, 5), 0.05792, 1e-4), 'P_bad(p=0.2, r=5) matches the spec figure ~5.8%');
A(near(poisonProbability(0.2, 7), 0.03334, 1e-4), 'P_bad(p=0.2, r=7) matches the spec figure ~3.3%');
A(near(poisonProbability(0.2, 9), 0.01958, 1e-4), 'P_bad(p=0.2, r=9) matches the spec figure ~1.9%');
A(poisonProbability(0.2, 9) < poisonProbability(0.2, 5), 'more replicas lower the poison probability');
A(poisonProbability(0, 5) === 0, 'no attackers -> no poisoning');
A(poisonProbability(1, 5) === 1, 'all attackers -> certain poisoning');
A(poisonProbability(0.6, 9) > 0.5, 'past 50% attacker share, redundancy stops saving you');
A(Number.isNaN(poisonProbability(1.5, 5)), 'an out-of-range p is rejected');
A(poisonProbability(0.2, 201) >= 0, 'large r does not overflow the binomial');
{
    const r = replicasFor(0.2, 0.02);
    A(r === 9, 'replicasFor picks the smallest odd r meeting the target');
    A(poisonProbability(0.2, r) <= 0.02, 'the chosen r actually meets the target');
    A(replicasFor(0.6, 1e-9) === null, 'an unachievable target reports failure instead of a wrong r');
}
{
    const bad = stakeIsSufficient({ expectedGain: 1000, pDetect: 0.1, stake: 5000 });
    A(!bad.sufficient, 'stake below gain/p_detect is insufficient');
    A(near(bad.requiredStake, 10000), 'the required stake is gain / p_detect');
    const ok = stakeIsSufficient({ expectedGain: 1000, pDetect: 0.1, stake: 20000 });
    A(ok.sufficient && ok.margin > 0, 'a large enough stake makes cheating negative-EV');
    A(!stakeIsSufficient({ expectedGain: 1, pDetect: 0, stake: 1e9 }).sufficient,
      'undetectable fraud can never be deterred by stake alone');
}

console.log('ALL ' + n + ' VERIFY TESTS PASSED');
