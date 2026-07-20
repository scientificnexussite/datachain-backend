// Unit tests for the AI-Treasury settlement engine (F2/F3/F8/F12/F22).
//   run:  node tests/treasury.test.js       (from DataChain_Core/)
// These MUST pass before epoch settlement is ever activated — see epoch.js EPOCH_1_HEIGHT.
import { settleEpoch, settleQueue, buildEpochBatch, cappedShares, hostWeight, PRIORITY }
    from '../treasury.js';

let n = 0; const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ── F3 weight sanitation ──────────────────────────────────────────────
A(hostWeight({ q: 1, u: 1, f: 100 }) === 100, 'weight = q*u*f');
A(hostWeight({ q: 0.5, u: 0.5, f: 100 }) === 25, 'weight scales by honesty and uptime');
A(hostWeight({ q: 2, u: 1, f: 10 }) === 10, 'q clamped to 1');
A(hostWeight({ q: -1, u: 1, f: 10 }) === 0, 'negative q contributes nothing');
A(hostWeight({ q: 1, u: 1, f: -5 }) === 0, 'negative FLOPs contribute nothing');
A(hostWeight({ q: 1, u: 1, f: NaN }) === 0, 'NaN FLOPs contribute nothing');
A(hostWeight(null) === 0, 'null host contributes nothing');

// ── F3 proportionality (cap wide enough not to bind) ──────────────────
{
    const s = cappedShares([{ address: 'a', q: 1, u: 1, f: 100 }, { address: 'b', q: 1, u: 1, f: 300 }], 1);
    A(near(s[0], 0.25) && near(s[1], 0.75), 'shares are proportional to verified work');
    A(near(sum(s), 1), 'uncapped shares sum to 1');
}

// ── F12 cap binds, excess redistributes, cap still holds ──────────────
{
    const hosts = [{ address: 'whale', q: 1, u: 1, f: 1e6 }];
    for (let i = 0; i < 10; i++) hosts.push({ address: 'h' + i, q: 1, u: 1, f: 1 });
    const cap = 0.005;
    const s = cappedShares(hosts, cap);
    A(s[0] <= cap + 1e-12, 'whale is capped at C_CAP');
    A(s.every(x => x <= cap + 1e-12), 'every share still respects the cap after redistribution');
    A(sum(s) <= 1 + 1e-12, 'shares never exceed 1');
}
{
    const one = cappedShares([{ address: 'solo', q: 1, u: 1, f: 10 }], 0.005);
    A(near(one[0], 0.005), 'a lone host is still capped (no concentration)');
    A(sum(one) <= 1, 'a capped lone host cannot over-allocate');
}
A(sum(cappedShares([{ address: 'a', q: 1, u: 1, f: 0 }], 0.5)) === 0, 'zero verified work -> zero shares');
A(sum(cappedShares([], 0.5)) === 0, 'empty host list -> no shares');

// ── F8 SOLVENCY across randomized scenarios ───────────────────────────
{
    for (let t = 0; t < 400; t++) {
        const k = 1 + Math.floor(Math.random() * 40);
        const hosts = [];
        for (let i = 0; i < k; i++) hosts.push({
            address: 'h' + i, q: Math.random(), u: Math.random(),
            f: Math.random() * 1e6, home: Math.random() < 0.5
        });
        const pool = Math.random() * 100000;
        const r = settleEpoch({ pool, hosts });
        A(r.totalPaid <= pool + 1e-6, 'F8: total paid never exceeds the pool');
        A(r.unallocated >= -1e-9, 'unallocated is never negative');
        A(r.payouts.every(p => p.amount > 0), 'no zero or negative payouts');
    }
}

// ── F12 reserved home slice ───────────────────────────────────────────
{
    const hosts = [
        { address: 'home1', q: 1, u: 1, f: 1, home: true },
        { address: 'open1', q: 1, u: 1, f: 1, home: false }
    ];
    const r = settleEpoch({ pool: 1000, hosts, params: { C_CAP: 1 } });
    const by = Object.fromEntries(r.payouts.map(p => [p.address, p.amount]));
    A(near(by.home1, 750), 'home host gets the reserved slice plus its open share');
    A(near(by.open1, 250), 'open-only host gets the open share only');
    A(near(r.totalPaid, 1000), 'entire pool allocated when nothing is capped');
}

// ── determinism (consensus requires byte-identical batches) ───────────
{
    const hosts = [{ address: 'zz', q: 1, u: 1, f: 5 }, { address: 'aa', q: 1, u: 1, f: 5 }, { address: 'mm', q: 1, u: 1, f: 5 }];
    const r1 = settleEpoch({ pool: 100, hosts, params: { C_CAP: 1 } });
    const r2 = settleEpoch({ pool: 100, hosts: hosts.slice().reverse(), params: { C_CAP: 1 } });
    A(JSON.stringify(r1.payouts) === JSON.stringify(r2.payouts), 'batch identical regardless of input order');
    A(r1.payouts.map(p => p.address).join() === 'aa,mm,zz', 'payouts are address-sorted');
}

// ── degenerate inputs ─────────────────────────────────────────────────
A(settleEpoch({ pool: 0, hosts: [{ address: 'a', q: 1, u: 1, f: 1 }] }).payouts.length === 0, 'zero pool pays nothing');
A(settleEpoch({ pool: -5, hosts: [{ address: 'a', q: 1, u: 1, f: 1 }] }).totalPaid === 0, 'negative pool pays nothing');
A(settleEpoch({ pool: 100, hosts: [] }).unallocated === 100, 'no hosts -> whole pool stays in treasury');
A(settleEpoch().payouts.length === 0, 'no arguments -> safe empty batch');

// ── F22 queue: priority, coverage, non-negative balance ───────────────
{
    const r = settleQueue({
        balance: 120, obligations: [
            { id: 's1', address: 'ceo',   amount: 100, priority: PRIORITY.SALARY },
            { id: 'h1', address: 'host1', amount: 60,  priority: PRIORITY.HOST },
            { id: 'h2', address: 'host2', amount: 50,  priority: PRIORITY.HOST }
        ]
    });
    const paid = r.paid.map(o => o.id);
    A(paid.includes('h1') && paid.includes('h2'), 'hosts are paid before salaries');
    A(!paid.includes('s1'), 'salary is not paid when hosts consumed the balance');
    A(r.pending.map(o => o.id).includes('s1'), 'unpaid salary stays PENDING');
    A(near(r.balanceAfter, 10), 'balance reduced by exactly what was paid');
    A(r.balanceAfter >= 0, 'balance never goes negative');
}
{
    const r = settleQueue({ balance: 0, obligations: [{ id: 'a', amount: 5, priority: 0 }] });
    A(r.paid.length === 0 && r.pending.length === 1, 'empty treasury pays nothing');
    A(r.balanceAfter === 0, 'zero balance stays zero');
}
{
    const r = settleQueue({ balance: 1000, obligations: [] });
    A(r.paid.length === 0 && r.pending.length === 0 && r.balanceAfter === 1000, 'no obligations leaves balance untouched');
}
{
    const r = settleQueue({
        balance: 50, obligations: [
            { id: 'big', amount: 100, priority: 0 },
            { id: 'small', amount: 20, priority: 0 }
        ]
    });
    A(r.paid.map(o => o.id).includes('small'), 'an unaffordable obligation does not block affordable ones');
    A(r.pending.map(o => o.id).includes('big'), 'the unaffordable obligation stays pending');
    A(near(r.balanceAfter, 30), 'balance correct after partial settlement');
}

// ── F22 carry-over: an underfunded epoch pays later, and is not starved ───
{
    const hosts = [{ address: 'h1', q: 1, u: 1, f: 1, home: true }];
    // epoch 1: 1000 SYR of work earned but only 100 in the treasury
    const e1 = buildEpochBatch({ epoch: 1, balance: 100, epochPool: 1000, hosts, params: { C_CAP: 1 } });
    A(e1.totalPaid === 0, 'an obligation larger than the balance is not partially paid');
    A(e1.pending.length === 1, 'the unpayable obligation is carried');
    A(e1.pending[0].since === 1, 'carried obligation remembers its epoch');

    // epoch 2: treasury now flush -> the old debt clears
    const e2 = buildEpochBatch({
        epoch: 2, balance: 5000, epochPool: 0, hosts: [], carriedPending: e1.pending, params: { C_CAP: 1 }
    });
    A(e2.payouts.length === 1 && e2.payouts[0].since === 1, 'the carried debt is paid in a later epoch');
    A(e2.pending.length === 0, 'nothing left pending once funded');
}
{
    // FIFO within a priority: the older debt wins when only one can be paid
    const r = settleQueue({
        balance: 100, obligations: [
            { id: 'new', address: 'h', amount: 100, priority: PRIORITY.HOST, since: 9 },
            { id: 'old', address: 'h', amount: 100, priority: PRIORITY.HOST, since: 2 }
        ]
    });
    A(r.paid.length === 1 && r.paid[0].id === 'old', 'older debts are paid before newer ones');
}
{
    // priority still outranks age: a fresh host beats an ancient salary
    const r = settleQueue({
        balance: 100, obligations: [
            { id: 'salary', amount: 100, priority: PRIORITY.SALARY, since: 1 },
            { id: 'host',   amount: 100, priority: PRIORITY.HOST,   since: 99 }
        ]
    });
    A(r.paid.length === 1 && r.paid[0].id === 'host', 'hosts outrank salaries regardless of age');
}

// ── multi-epoch chain simulation: the treasury can never overdraw ─────────
{
    const EPOCH_BLOCKS = 8640, TREASURY_PER_BLOCK = 13;
    const accrual = EPOCH_BLOCKS * TREASURY_PER_BLOCK;   // 112,320 SYR per daily epoch
    let balance = 0, accrued = 0, paidTotal = 0, pending = [];

    for (let epoch = 1; epoch <= 120; epoch++) {
        balance += accrual; accrued += accrual;
        const hosts = [];
        const k = Math.floor(Math.random() * 30);
        for (let i = 0; i < k; i++) hosts.push({
            address: 'host' + i, q: Math.random(), u: Math.random(),
            f: Math.random() * 1e9, home: Math.random() < 0.4
        });
        const r = buildEpochBatch({ epoch, balance, epochPool: accrual, hosts, carriedPending: pending });
        A(r.balanceAfter >= -1e-6, 'treasury balance never goes negative across epochs');
        A(r.totalPaid <= balance + 1e-6, 'an epoch never pays more than the treasury holds');
        balance = r.balanceAfter; pending = r.pending; paidTotal += r.totalPaid;
        A(near(balance, accrued - paidTotal, 1e-3), 'balance always equals accrued minus paid (no SYR invented or lost)');
    }
    A(paidTotal <= accrued + 1e-6, 'lifetime payouts never exceed lifetime treasury income');
}

console.log('ALL ' + n + ' TREASURY TESTS PASSED');
