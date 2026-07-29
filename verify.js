// ════════════════════════════════════════════════════════════════════════════════
// verify.js — verified-work credit and redundancy consensus   (F6 / F16, M1)
//
// This is the missing half of M1. epoch.js can already turn verified-work receipts into
// on-ledger payouts, but getVerifiedWorkReceipts() returns [] because NOTHING produced
// them. This module is what produces them: it takes the raw results hosts submitted for
// each redundantly-computed shard and decides
//
//     which results are ACCEPTED          (F6 — Byzantine majority within tolerance eps)
//     how much verified work each host is CREDITED   (F16 — priced shard cost, capped)
//     how each host's HONESTY score moves (q_i, feeding F3 via treasury.js)
//
// PURE and DETERMINISTIC, exactly like treasury.js and powpolicy.js: identical inputs
// produce a byte-identical receipt set on every node, so an epoch's receipts can be
// validated the same way a block reward is. No wall-clock, no randomness, no map order.
//
//   F6  accept if (# hosts agreeing within eps) >= floor(r/2) + 1
//   F6  P_bad = SUM_{k=ceil(r/2)}^{r} C(r,k) p^k (1-p)^(r-k)      (choosing r)
//   F6  economic backstop: rational hosts stay honest when  gain < p_detect * S
//   F16 f_i += c_s * [verified],  subject to  credited_i(window) <= kappa * B_i
//
// ── NOT WIRED IN ────────────────────────────────────────────────────────────────
// Nothing calls this yet, and epoch settlement stays dormant (EPOCH_1_HEIGHT is
// MAX_SAFE_INTEGER). It activates only once a real worker protocol submits shard
// results on-ledger — the M0 hand-off. Building it now means the moment receipts
// exist, the path from "host did work" to "host got paid" is already closed and tested.
//
// NOTE: a behaviourally identical CommonJS mirror belongs in Exe/core/ once the exe
// also validates epochs — same rule as powpolicy.js and treasury.js.
// ════════════════════════════════════════════════════════════════════════════════

export const VERIFY_DEFAULTS = {
    R:        5,      // replicas per shard. p=0.2 -> P_bad ~5.8%; raise for stronger guarantees
    EPS:      1e-6,   // agreement tolerance: |a - b| <= EPS counts as the same result
    KAPPA:    1.25,   // F16 cap margin over measured capacity B_i (25% headroom)
    // ── honesty (q_i) update — OPEN PARAM in F6, DECIDED HERE ────────────────────
    // EWMA over per-shard outcomes, deliberately ASYMMETRIC: dishonesty must cost more
    // than honesty earns, or a host can profitably alternate cheat/behave. Recovery is
    // possible but slow, so a compromised-then-fixed host is not banned forever.
    Q_INIT:   0.5,    // a brand-new host is neither trusted nor condemned
    Q_UP:     0.02,   // weight on an agreeing result (slow climb)
    Q_DOWN:   0.20,   // weight on a dissenting result (fast fall) — 10x the climb
    Q_FLOOR:  0,
    Q_CEIL:   1
};

const clamp = (x, lo, hi) => (x < lo ? lo : (x > hi ? hi : x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const nonNeg = (x) => { const n = Number(x); return (!Number.isFinite(n) || n < 0) ? 0 : n; };

// ── F6: agreement ──────────────────────────────────────────────────────────────

/**
 * Distance between two submitted results. Scalars compare by |a-b|; vectors by max
 * absolute component difference (L-infinity), so eps means the same thing either way:
 * "no single number is off by more than eps".
 * Returns Infinity for shape mismatches or non-numeric junk — those can never agree.
 */
export function resultDistance(a, b) {
    if (isNum(a) && isNum(b)) return Math.abs(a - b);
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length || a.length === 0) return Infinity;
        let worst = 0;
        for (let i = 0; i < a.length; i++) {
            if (!isNum(a[i]) || !isNum(b[i])) return Infinity;
            const d = Math.abs(a[i] - b[i]);
            if (d > worst) worst = d;
        }
        return worst;
    }
    // A submitted hash / opaque string: identical or nothing.
    if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : Infinity;
    return Infinity;
}

/**
 * F6 — decide a shard from its r redundant submissions.
 *
 * Finds the largest cluster of mutually-close results and accepts it only if it holds a
 * Byzantine majority (floor(r/2)+1). eps-closeness is NOT transitive, so clusters are
 * built around each submission as a centre and the largest wins; ties break on the
 * lowest submitter address, keeping the outcome identical on every node.
 *
 * @param {object} args
 * @param {Array}  args.submissions [{ address, result }] — one per replica
 * @returns {{accepted:boolean, quorum:number, required:number, agreed:string[],
 *            dissented:string[], participants:string[], centre:string|null}}
 *          participants is ALWAYS every distinct submitter, even on a split, so the
 *          caller can register who took part without inferring it from agreed/dissented.
 */
export function decideShard({ submissions, eps = VERIFY_DEFAULTS.EPS } = {}) {
    const subs = (Array.isArray(submissions) ? submissions : [])
        .filter(s => s && typeof s.address === 'string' && s.address.length > 0);

    // One submission per address — a host cannot vote twice. First wins, then sort, so
    // duplicate spam cannot change the outcome or the ordering.
    const seen = new Set();
    const list = [];
    for (const s of subs) {
        if (seen.has(s.address)) continue;
        seen.add(s.address);
        list.push(s);
    }
    list.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

    const r = list.length;
    const required = Math.floor(r / 2) + 1;
    const participants = list.map(s => s.address);
    if (r === 0) {
        return { accepted: false, quorum: 0, required: 1, agreed: [], dissented: [], participants: [], centre: null };
    }

    const tol = nonNeg(eps);
    let best = null;
    for (let i = 0; i < r; i++) {
        const members = [];
        for (let j = 0; j < r; j++) {
            if (resultDistance(list[i].result, list[j].result) <= tol) members.push(list[j].address);
        }
        // Strictly greater keeps the FIRST (lowest-address) centre on a tie.
        if (best === null || members.length > best.members.length) {
            best = { centre: list[i].address, members };
        }
    }

    const quorum = best.members.length;
    if (quorum < required) {
        // No majority: nobody is credited. Dissent is not attributable here — the shard
        // simply failed — so honesty is left untouched by the caller (see creditShard).
        return { accepted: false, quorum, required, agreed: [], dissented: [], participants, centre: null, split: true };
    }

    const agreedSet = new Set(best.members);
    return {
        accepted: true,
        quorum,
        required,
        centre: best.centre,
        agreed: best.members.slice(),
        dissented: list.filter(s => !agreedSet.has(s.address)).map(s => s.address),
        participants
    };
}

// ── F16: verified-work credit ──────────────────────────────────────────────────

/**
 * F16 — credit one decided shard.
 *
 * Only hosts in the accepted majority earn the shard's protocol-known cost c_s; lazy or
 * wrong hosts earn ZERO, which is the whole anti-fake property. Honesty moves per the
 * asymmetric EWMA above.
 *
 * @param {object} args
 * @param {object} args.decision  from decideShard
 * @param {number} args.shardCost c_s — the shard's known FLOP cost
 * @param {Map}    args.ledger    address -> { f, q, shards, dissents } (mutated)
 */
export function creditShard({ decision, shardCost, ledger, params = {} } = {}) {
    const p = { ...VERIFY_DEFAULTS, ...params };
    const cost = nonNeg(shardCost);
    if (!decision || !(ledger instanceof Map)) return ledger;

    const touch = (address) => {
        if (!ledger.has(address)) {
            ledger.set(address, { f: 0, q: p.Q_INIT, shards: 0, dissents: 0 });
        }
        return ledger.get(address);
    };

    // A split shard (no majority) is inconclusive: nobody is paid and nobody is blamed.
    // Punishing everyone here would let one attacker damage every honest host's q by
    // deliberately forcing splits.
    if (!decision.accepted) {
        for (const a of (decision.participants || [])) touch(a);   // registered, q untouched
        return ledger;
    }

    for (const address of decision.agreed) {
        const rec = touch(address);
        rec.f += cost;                                     // f_i += c_s * [verified]
        rec.shards += 1;
        rec.q = clamp(rec.q + p.Q_UP * (p.Q_CEIL - rec.q), p.Q_FLOOR, p.Q_CEIL);
    }
    for (const address of decision.dissented) {
        const rec = touch(address);
        rec.dissents += 1;
        rec.q = clamp(rec.q - p.Q_DOWN * (rec.q - p.Q_FLOOR), p.Q_FLOOR, p.Q_CEIL);
    }
    return ledger;
}

/**
 * F16 — plausibility cap. A host may not be credited more than its measured hardware
 * could physically have produced this window: credited_i <= kappa * B_i.
 *
 * Anything above the cap is WITHHELD (returned separately) rather than silently dropped,
 * because an over-claim is an audit signal, not just a rounding issue.
 */
export function applyBenchmarkCap(f, benchmark, kappa = VERIFY_DEFAULTS.KAPPA) {
    const claimed = nonNeg(f);
    const b = Number(benchmark);
    // No benchmark yet -> no cap can be justified. Credit as-is and flag it, rather than
    // inventing a limit that would silently underpay a legitimately fast host.
    if (!Number.isFinite(b) || b <= 0) {
        return { credited: claimed, withheld: 0, capped: false, unbenchmarked: true };
    }
    const cap = nonNeg(kappa) * b;
    if (claimed <= cap) return { credited: claimed, withheld: 0, capped: false, unbenchmarked: false };
    return { credited: cap, withheld: claimed - cap, capped: true, unbenchmarked: false };
}

// ── epoch assembly: shards in, receipts out ────────────────────────────────────

/**
 * Turn one epoch's shard submissions into the receipts epoch.js consumes.
 *
 * @param {object} args
 * @param {Array}  args.shards  [{ id, shardCost, submissions:[{address,result}] }]
 * @param {object} args.hosts   address -> { benchmark, uptime, home } (hardware + heartbeats)
 * @returns {{receipts:Array, audit:Array, stats:object}}
 *          receipts are [{ address, f, q, u, home }] — exactly F3's inputs — sorted by
 *          address so every node produces an identical set.
 */
export function buildReceipts({ shards, hosts = {}, params = {} } = {}) {
    const p = { ...VERIFY_DEFAULTS, ...params };
    const ledger = new Map();
    const list = Array.isArray(shards) ? shards : [];

    let accepted = 0, split = 0;
    // Sort shards by id first: crediting is additive so order cannot change totals, but a
    // fixed order keeps any future order-sensitive rule (and debug logs) reproducible.
    const ordered = list.slice().sort((a, b) => {
        const ia = String((a && a.id) ?? ''), ib = String((b && b.id) ?? '');
        return ia < ib ? -1 : ia > ib ? 1 : 0;
    });

    for (const shard of ordered) {
        if (!shard) continue;
        const decision = decideShard({ submissions: shard.submissions, eps: p.EPS });
        if (decision.accepted) accepted++; else if (decision.split) split++;
        creditShard({ decision, shardCost: shard.shardCost, ledger, params: p });
    }

    const receipts = [];
    const audit = [];
    for (const [address, rec] of ledger) {
        const meta = (hosts && hosts[address]) || {};
        const cap = applyBenchmarkCap(rec.f, meta.benchmark, p.KAPPA);
        if (cap.capped) {
            audit.push({ address, claimed: rec.f, credited: cap.credited, withheld: cap.withheld,
                         reason: 'over-benchmark' });
        }
        // A host with no verified work earns nothing; emitting a zero receipt would only
        // add noise to the payout batch (treasury.js drops zero shares anyway).
        if (cap.credited <= 0) continue;
        receipts.push({
            address,
            f: cap.credited,
            q: clamp(rec.q, p.Q_FLOOR, p.Q_CEIL),
            u: clamp(Number(meta.uptime ?? 0), 0, 1),
            home: !!meta.home
        });
    }

    receipts.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    audit.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

    return {
        receipts,
        audit,
        stats: {
            shards: ordered.length,
            acceptedShards: accepted,
            splitShards: split,
            hosts: receipts.length,
            totalCredited: receipts.reduce((s, r) => s + r.f, 0)
        }
    };
}

// ── F6 calibration helpers (not consensus code — for choosing r and S) ─────────

/**
 * F6 — probability a poisoned result wins a shard, given malicious fraction p and r
 * replicas. Attacker must control a majority of the replicas.
 *
 * Computed with log-factorials so large r cannot overflow the binomial coefficient.
 */
export function poisonProbability(p, r) {
    const frac = Number(p), n = Math.floor(Number(r));
    if (!Number.isFinite(frac) || frac < 0 || frac > 1) return NaN;
    if (!Number.isFinite(n) || n <= 0) return NaN;
    if (frac === 0) return 0;
    if (frac === 1) return 1;

    const logFact = new Array(n + 1).fill(0);
    for (let i = 2; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
    const logC = (a, b) => logFact[a] - logFact[b] - logFact[a - b];

    let total = 0;
    for (let k = Math.ceil(n / 2); k <= n; k++) {
        total += Math.exp(logC(n, k) + k * Math.log(frac) + (n - k) * Math.log(1 - frac));
    }
    return clamp(total, 0, 1);
}

/**
 * F6 — smallest odd r whose poison probability is at or below a target, so r can be
 * chosen from a security goal instead of guessed. Odd r avoids exact-tie majorities.
 */
export function replicasFor(p, target, maxR = 51) {
    for (let r = 3; r <= maxR; r += 2) {
        if (poisonProbability(p, r) <= target) return r;
    }
    return null;
}

/**
 * F6 economic backstop — is cheating negative-EV?  gain < p_detect * S
 * Returns the verdict plus the stake that WOULD make it so, which is the number an
 * operator actually needs when setting S.
 */
export function stakeIsSufficient({ expectedGain, pDetect, stake } = {}) {
    const g = nonNeg(expectedGain), pd = clamp(Number(pDetect) || 0, 0, 1), s = nonNeg(stake);
    if (pd <= 0) return { sufficient: false, requiredStake: Infinity, margin: -Infinity };
    const required = g / pd;
    return { sufficient: pd * s > g, requiredStake: required, margin: pd * s - g };
}
