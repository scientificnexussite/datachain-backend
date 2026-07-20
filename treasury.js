// ════════════════════════════════════════════════════════════════════════════════
// treasury.js — Autonomous AI Treasury settlement engine   (F2 / F3 / F8 / F12 / F22)
//
// The treasury fills at 13 SYR/block (F23) and pays AI hosts by VERIFIED WORK. This module
// is PURE and DETERMINISTIC: identical inputs produce an identical payout batch on every
// node, so an epoch batch can be validated exactly like the block reward (05 sec.2) with
// no human signing anything.
//
//   F2  payout_i   = Pool(period) * share_i          (settlement period: daily)
//   F3  share_i  proportional to q_i * u_i * f_i     (honesty * uptime * verified FLOPs)
//   F12 shares are capped per identity (C_CAP) and a slice (RHO_HOME) is reserved for
//       verified home hosts, so no single entity can dominate.
//   F8  SUM(payouts) <= Pool                          (solvency — enforced, then re-checked)
//   F22 obligations settle in PRIORITY order (hosts before salaries); anything the balance
//       cannot cover stays PENDING for the next interval. Balance never goes negative.
//
// NOTE: a behaviourally identical CommonJS mirror belongs in Exe/core/ once the exe also
// validates epochs — same rule as powpolicy.js.
// ════════════════════════════════════════════════════════════════════════════════

export const TREASURY_DEFAULTS = {
    RHO_HOME: 0.5,     // slice reserved for verified home hosts (05 / R6)
    C_CAP:    0.005,   // max share ONE identity may take inside a sub-pool (0.5%, 05 / R6)
    DUST:     1e-8     // payouts at or below this are dropped and stay in the treasury
};

// Obligation priorities (F22): hosts keep Pefe alive, so they are paid first.
export const PRIORITY = { HOST: 0, SERVING: 5, SALARY: 10 };

const clamp01 = (x) => { const n = Number(x); return !isFinite(n) ? 0 : (n < 0 ? 0 : (n > 1 ? 1 : n)); };
const nonNeg  = (x) => { const n = Number(x); return (!isFinite(n) || n < 0) ? 0 : n; };

/** F3 weight for one host: q * u * f. Invalid, negative or NaN inputs contribute nothing. */
export function hostWeight(h) {
    if (!h) return 0;
    return clamp01(h.q) * clamp01(h.u) * nonNeg(h.f);
}

/**
 * F3 + F12 — shares proportional to verified-work weight, with every share capped at cCap.
 * When a host hits the cap its excess is redistributed to the others, repeatedly, until
 * every share respects the cap. Shares always sum to <= 1 (never more), so any unallocated
 * remainder simply stays in the treasury.
 */
export function cappedShares(hosts, cCap = TREASURY_DEFAULTS.C_CAP) {
    const list = Array.isArray(hosts) ? hosts : [];
    const n = list.length;
    const shares = new Array(n).fill(0);
    if (n === 0 || !(cCap > 0)) return shares;

    const w = list.map(hostWeight);
    if (w.reduce((a, b) => a + b, 0) <= 0) return shares;   // nobody did verified work

    const capped = new Array(n).fill(false);

    // At most n rounds: each round caps at least one more host, or settles.
    for (let round = 0; round <= n; round++) {
        let cappedTotal = 0, freeW = 0;
        for (let i = 0; i < n; i++) {
            if (capped[i]) cappedTotal += cCap;
            else freeW += w[i];
        }
        const remaining = Math.max(0, 1 - cappedTotal);
        if (freeW <= 0 || remaining <= 0) break;

        let newlyCapped = false;
        for (let i = 0; i < n; i++) {
            if (capped[i]) continue;
            if (remaining * (w[i] / freeW) > cCap) { capped[i] = true; newlyCapped = true; }
        }
        if (!newlyCapped) {
            for (let i = 0; i < n; i++) {
                shares[i] = capped[i] ? cCap : remaining * (w[i] / freeW);
            }
            break;
        }
    }
    for (let i = 0; i < n; i++) if (capped[i]) shares[i] = cCap;

    // Safety net: shares can never sum above 1 (protects F8 against any edge case).
    const total = shares.reduce((a, b) => a + b, 0);
    if (total > 1) for (let i = 0; i < n; i++) shares[i] /= total;
    return shares;
}

/**
 * F2 + F12 — settle one epoch. The pool is split into the reserved home slice and the open
 * slice; inside each, hosts are paid their capped verified-work share.
 *
 * @param {object}   args
 * @param {number}   args.pool   SYR accumulated in the treasury this period
 * @param {Array}    args.hosts  [{ address, f, q, u, home }]
 * @returns {{payouts: Array<{address:string, amount:number}>, totalPaid:number, unallocated:number}}
 *          payouts are address-sorted so every node produces a byte-identical batch.
 */
export function settleEpoch({ pool, hosts, params = {} } = {}) {
    const p = Object.assign({}, TREASURY_DEFAULTS, params);
    const poolAmt = nonNeg(pool);
    const list = Array.isArray(hosts) ? hosts.filter(h => h && h.address) : [];

    const homeHosts = list.filter(h => !!h.home);     // verified home hosts only
    const homePool  = poolAmt * clamp01(p.RHO_HOME);
    const openPool  = poolAmt - homePool;             // open slice: everyone competes

    const acc = new Map();
    const credit = (address, amount) => {
        if (!address || !(amount > p.DUST)) return;
        acc.set(address, (acc.get(address) || 0) + amount);
    };
    const allocate = (subPool, subHosts) => {
        if (!(subPool > 0) || subHosts.length === 0) return;
        const shares = cappedShares(subHosts, p.C_CAP);
        subHosts.forEach((h, i) => credit(h.address, subPool * shares[i]));
    };

    allocate(homePool, homeHosts);
    allocate(openPool, list);

    const payouts = Array.from(acc.entries())
        .map(([address, amount]) => ({ address, amount }))
        .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

    const totalPaid = payouts.reduce((s, x) => s + x.amount, 0);
    return { payouts, totalPaid, unallocated: Math.max(0, poolAmt - totalPaid) };
}

/**
 * F22 — settle obligations against the treasury balance in PRIORITY order (hosts first).
 * Anything the balance cannot cover stays PENDING and is retried next interval. The
 * balance never goes negative.
 *
 * @param {object} args
 * @param {number} args.balance      current treasury balance
 * @param {Array}  args.obligations  [{ id, address, amount, priority }]
 */
export function settleQueue({ balance, obligations } = {}) {
    let bal = nonNeg(balance);
    const paid = [], pending = [];

    const queue = (Array.isArray(obligations) ? obligations.slice() : []).sort((a, b) => {
        const pa = Number(a && a.priority) || 0, pb = Number(b && b.priority) || 0;
        if (pa !== pb) return pa - pb;                       // lower priority number pays first
        const sa = Number(a && a.since) || 0, sb = Number(b && b.since) || 0;
        if (sa !== sb) return sa - sb;                       // FIFO: old debts before new ones
        const ia = String(a && a.id), ib = String(b && b.id);
        return ia < ib ? -1 : ia > ib ? 1 : 0;               // stable, deterministic tie-break
    });

    for (const o of queue) {
        const amount = nonNeg(o && o.amount);
        if (amount > 0 && bal >= amount) {
            bal -= amount;
            paid.push(Object.assign({}, o, { amount, status: 'PAID' }));
        } else {
            pending.push(Object.assign({}, o, { amount, status: 'PENDING' }));
        }
    }
    return { paid, pending, balanceAfter: bal };
}

/**
 * One complete epoch settlement — the function a node actually calls.
 * Turns this epoch's verified work into host obligations (F2/F3/F12), merges them with
 * everything still owed from earlier epochs (F22), and pays as far as the real treasury
 * balance reaches: hosts first, oldest debt first. Whatever is left stays PENDING.
 *
 * @param {object} args
 * @param {number} args.epoch           monotonic epoch number (drives FIFO order and ids)
 * @param {number} args.balance         SYR the treasury can actually spend right now
 * @param {number} args.epochPool       SYR that accrued to the treasury during this epoch
 * @param {Array}  args.hosts           verified-work receipts [{ address, f, q, u, home }]
 * @param {Array}  args.carriedPending  obligations earlier epochs could not cover
 */
export function buildEpochBatch({ epoch = 0, balance = 0, epochPool = 0,
                                  hosts = [], carriedPending = [], params = {} } = {}) {
    const settled = settleEpoch({ pool: epochPool, hosts, params });

    const fresh = settled.payouts.map(p => ({
        id: 'e' + epoch + ':' + p.address,
        address: p.address,
        amount: p.amount,
        priority: PRIORITY.HOST,
        since: epoch
    }));

    const carried = (Array.isArray(carriedPending) ? carriedPending : [])
        .filter(o => o && o.address && nonNeg(o.amount) > 0)
        .map(o => Object.assign({}, o, { since: Number(o.since) || 0 }));

    const { paid, pending, balanceAfter } = settleQueue({
        balance,
        obligations: carried.concat(fresh)
    });

    return {
        payouts: paid,
        pending,
        totalPaid: paid.reduce((s, o) => s + o.amount, 0),
        balanceAfter,
        unallocated: settled.unallocated
    };
}
