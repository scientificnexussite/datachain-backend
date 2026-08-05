/* ════════════════════════════════════════════════════════════════════════════════════════
   serving.js — paying the machines that serve the website.

   THE JOB. Once Railway is off, scientificnexus.net is served by volunteers' copies of
   DataChain-Core. Volunteers spend electricity and upload bandwidth; something has to make
   that worth doing, or the network is one person's PC wearing a decentralisation costume.

   ── THE PAYOUT RULE (owner decision, and what 05_TOKENOMICS §3 actually specifies) ──────
   A FIXED daily pool, split by share. NOT a flat amount per node.

   This distinction is the difference between solvent and not. 05_TOKENOMICS is explicit
   (§3, lines 98-100): "this is exactly why we distribute by SHARE rather than a flat
   '1 SYR per host' (which would drain once host count grows)". A flat rate per node is an
   unbounded liability — 10,000 nodes would owe 10,000 SYR/day forever, and it pays a node
   that answered one request the same as one that carried the whole site. A fixed pool
   divided by share can never promise more than it holds, and self-regulates: as more nodes
   join, per-node reward falls until it settles where it is just worth doing.

   ── WHAT IS ACTUALLY PROVEN, AND WHAT IS NOT ────────────────────────────────────────────
   This is the part it would be easy to lie about, so it is stated plainly.

   PROVEN: that a node was REACHABLE and answered correctly, at times it did not control.
   Other nodes probe it at unpredictable moments; each successful probe is a signed receipt
   from the prober. Uptime is the honest, verifiable quantity, and it is what pay is based on.

   NOT PROVEN: how many bytes a node served to real visitors. A node self-reporting "I served
   4 GB" cannot be checked by anyone, so believing it would simply pay the best liar. Byte
   counts are therefore recorded for observability and DELIBERATELY NOT PAID ON.

   ── WHY A STAKE ────────────────────────────────────────────────────────────────────────
   Uptime alone is cheap to fake at scale: one machine can present a hundred identities and
   collect a hundred shares. Requiring each identity to hold SYR makes that cost 100x the
   stake, and the per-identity cap (F3/F12) bounds what any single entity can take even if
   it pays that cost. The plan names exactly this pairing as "the real backstop" (05 §3).
   ════════════════════════════════════════════════════════════════════════════════════════ */

import { cappedShares, PRIORITY, TREASURY_DEFAULTS } from './treasury.js';

export const SERVING_DEFAULTS = {
    /** SYR per day for the whole serving cohort. Split by share; never exceeded. */
    DAILY_POOL: 500,

    /** Minimum SYR an identity must hold to earn. The anti-sybil cost multiplier. */
    MIN_STAKE: 100,

    /** Below this uptime a node is not dependable enough to pay for. */
    MIN_UPTIME: 0.5,

    /** Independent probers a claim needs before it counts. One prober could just lie. */
    MIN_WITNESSES: 3,

    /** A receipt older than this is not evidence about this epoch. */
    RECEIPT_MAX_AGE_MS: 26 * 60 * 60 * 1000,

    /** Same per-identity cap as every other treasury payout. */
    C_CAP: TREASURY_DEFAULTS.C_CAP
};

const nonNeg = (x) => { const n = Number(x); return (!isFinite(n) || n < 0) ? 0 : n; };
const clamp01 = (x) => { const n = Number(x); return !isFinite(n) ? 0 : (n < 0 ? 0 : (n > 1 ? 1 : n)); };

/**
 * Uptime as measured by OTHER nodes' probes — not by the node's own claim.
 *
 * Receipts are counted per distinct prober, so a node cannot manufacture uptime by probing
 * itself a thousand times: a thousand receipts from one witness count as one witness.
 *
 * @param {Array} receipts  [{ prober, at, ok }]
 * @returns {{uptime:number, witnesses:number, probes:number, successes:number}}
 */
export function uptimeFromReceipts(receipts, { now = Date.now(), params = {} } = {}) {
    const p = Object.assign({}, SERVING_DEFAULTS, params);
    const list = Array.isArray(receipts) ? receipts : [];

    const byProber = new Map();
    for (const r of list) {
        if (!r || !r.prober) continue;
        const at = Number(r.at) || 0;
        if (!at || (now - at) > p.RECEIPT_MAX_AGE_MS) continue;   // stale: not about this epoch
        if (at > now + 60e3) continue;                            // clock-skew / future-dated
        const cur = byProber.get(r.prober) || { ok: 0, total: 0 };
        cur.total++;
        if (r.ok) cur.ok++;
        byProber.set(r.prober, cur);
    }

    let probes = 0, successes = 0;
    // Each WITNESS contributes its own success ratio, and the ratios are averaged. Summing
    // raw probes instead would let one prolific prober outvote everyone else — which is
    // precisely the leverage a self-probing node would try to buy.
    let ratioSum = 0;
    for (const [, v] of byProber) {
        probes += v.total;
        successes += v.ok;
        ratioSum += v.total > 0 ? v.ok / v.total : 0;
    }
    const witnesses = byProber.size;
    const uptime = witnesses > 0 ? clamp01(ratioSum / witnesses) : 0;

    return { uptime, witnesses, probes, successes };
}

/**
 * Decide whether one node's claim earns anything, and why not when it does not.
 * The reason is returned rather than logged, so the node's own UI can tell its operator
 * exactly what to fix instead of leaving them guessing at a zero.
 *
 * @param {object} claim   { address, stake, receipts, bytesServed }
 */
export function evaluateClaim(claim, { now = Date.now(), params = {} } = {}) {
    const p = Object.assign({}, SERVING_DEFAULTS, params);
    if (!claim || !claim.address) {
        return { eligible: false, reason: 'no-address', weight: 0 };
    }

    const stake = nonNeg(claim.stake);
    if (stake < p.MIN_STAKE) {
        return { eligible: false, reason: 'insufficient-stake', weight: 0,
                 detail: `holds ${stake} SYR, needs ${p.MIN_STAKE}` };
    }

    const { uptime, witnesses, probes } = uptimeFromReceipts(claim.receipts, { now, params: p });

    if (witnesses < p.MIN_WITNESSES) {
        return { eligible: false, reason: 'not-enough-witnesses', weight: 0, uptime, witnesses,
                 detail: `${witnesses} of ${p.MIN_WITNESSES} independent nodes have verified this one` };
    }
    if (uptime < p.MIN_UPTIME) {
        return { eligible: false, reason: 'uptime-too-low', weight: 0, uptime, witnesses,
                 detail: `${(uptime * 100).toFixed(1)}% reachable, needs ${(p.MIN_UPTIME * 100).toFixed(0)}%` };
    }

    // WEIGHT IS UPTIME, FULL STOP.
    // Not bytes (self-reported, unverifiable — see the header), and not stake. Weighting by
    // stake would make this a rent on wealth rather than a payment for work, and would hand
    // the network to whoever already holds the most SYR. Stake is a gate, never a multiplier.
    return {
        eligible: true,
        reason: null,
        weight: uptime,
        uptime,
        witnesses,
        probes,
        // Carried for the operator's own dashboard. Never used in the payout maths.
        bytesServedReported: nonNeg(claim.bytesServed)
    };
}

/**
 * Turn this epoch's claims into treasury obligations.
 * Returns obligations shaped exactly like the storage rewards in buildEpochBatch, so they
 * flow through the same F22 solvency queue: serving can never be paid from money the
 * treasury does not hold.
 *
 * @param {object} args
 * @param {number} args.epoch
 * @param {number} args.pool    SYR available for serving this epoch (defaults to DAILY_POOL)
 * @param {Array}  args.claims  [{ address, stake, receipts, bytesServed }]
 */
export function settleServing({ epoch = 0, pool = null, claims = [], now = Date.now(), params = {} } = {}) {
    const p = Object.assign({}, SERVING_DEFAULTS, params);
    const poolAmt = nonNeg(pool == null ? p.DAILY_POOL : pool);

    const evaluated = (Array.isArray(claims) ? claims : []).map(c => ({
        claim: c,
        result: evaluateClaim(c, { now, params: p })
    }));

    const eligible = evaluated.filter(e => e.result.eligible);
    const rejected = evaluated.filter(e => !e.result.eligible)
        .map(e => ({ address: e.claim && e.claim.address, reason: e.result.reason, detail: e.result.detail }));

    if (poolAmt <= 0 || eligible.length === 0) {
        return { obligations: [], rejected, totalAllocated: 0, unallocated: poolAmt, eligibleCount: 0 };
    }

    // Reuse the treasury's capped-share maths so serving obeys the same anti-concentration
    // rule (and the same adaptive 1/n floor on a small network) as every other payout.
    const asHosts = eligible.map(e => ({ address: e.claim.address, q: 1, u: 1, f: e.result.weight }));
    const shares = cappedShares(asHosts, p.C_CAP);

    const obligations = eligible.map((e, i) => ({
        id: 'e' + epoch + ':serve:' + e.claim.address,
        address: e.claim.address,
        amount: poolAmt * shares[i],
        priority: PRIORITY.SERVING,
        since: epoch,
        uptime: e.result.uptime,
        witnesses: e.result.witnesses
    }))
    .filter(o => o.amount > TREASURY_DEFAULTS.DUST)
    // Address-sorted so every node builds a byte-identical batch and agrees on the block.
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

    const totalAllocated = obligations.reduce((s, o) => s + o.amount, 0);

    return {
        obligations,
        rejected,
        totalAllocated,
        unallocated: Math.max(0, poolAmt - totalAllocated),
        eligibleCount: eligible.length
    };
}

/**
 * What ONE node can expect to earn per day, for the UI.
 * Deliberately shows the dilution: an operator should understand before switching it on
 * that the reward per node falls as the network grows. Promising a fixed amount and then
 * quietly paying less is how good will gets spent.
 */
export function estimateDailyReward({ nodeCount = 1, uptime = 1, pool = null, params = {} } = {}) {
    const p = Object.assign({}, SERVING_DEFAULTS, params);
    const poolAmt = nonNeg(pool == null ? p.DAILY_POOL : pool);
    const n = Math.max(1, Math.floor(nodeCount));
    const cap = Math.max(p.C_CAP, 1 / n);          // same adaptive cap as cappedShares
    const evenShare = Math.min(cap, 1 / n);
    return {
        perNode: poolAmt * evenShare * clamp01(uptime),
        pool: poolAmt,
        nodeCount: n,
        note: 'A fixed pool split between serving nodes — the more nodes, the smaller each share.'
    };
}
