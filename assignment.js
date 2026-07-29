// ════════════════════════════════════════════════════════════════════════════════
// assignment.js — decentralized shard assignment   (F14, M3)
//
// Who computes which shard is decided by MATH every node can reproduce, not by a server:
//
//     assign(shard s, epoch e) = TopR_i  Hash( beacon_e || s || id_i )
//                                weighted by ( compute_class_i * q_i )
//
// This is what removes the central dispatcher. Coordinators become stateless, replaceable
// RELAYS that gossip jobs and results; they no longer decide anything, so there is nothing
// to capture. Randomized replica assignment for anti-collusion falls out for free (04).
//
// PROPERTIES, and why each matters:
//   DETERMINISTIC   every full node derives the SAME assignment, so it can be validated
//                   like any other consensus rule instead of trusted.
//   UNPREDICTABLE   nobody can compute it before beacon_e exists (F17), so an attacker
//                   cannot pre-position on a target shard or arrange to dodge an audit.
//   VERIFIABLE      anyone can recompute it afterwards and prove nobody cherry-picked.
//
// ── HOW WEIGHTING IS DONE (and why not the obvious way) ─────────────────────────
// "Top R by hash, weighted by capability" cannot be done by simply multiplying the hash by
// the weight: that biases the DRAW rather than the SELECTION PROBABILITY, and a huge weight
// would win every shard deterministically — the opposite of unpredictable.
//
// The correct construction is weighted reservoir sampling (Efraimidis-Spirakis):
//
//     u_i  = uniform(0,1) derived from Hash(beacon || shard || id_i)
//     key_i = u_i ^ (1 / w_i)          , w_i = compute_class_i * q_i
//     assignment = the r hosts with the LARGEST key
//
// This samples r hosts WITHOUT REPLACEMENT with probability proportional to weight, while
// staying a pure function of the hash — so it is simultaneously random, weighted, and
// fully reproducible by every node. A stronger host is more likely to be picked, never
// certain to be.
//
// PURE and DETERMINISTIC, like beacon.js / treasury.js / verify.js.
// ════════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';

export const ASSIGNMENT_DEFAULTS = {
    R: 5                    // replicas per shard — must match F6's redundancy factor
};

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Uniform value in [0,1) derived from the draw hash.
 *
 * Uses the top 52 bits, which is exactly what a JS double represents without loss. Taking
 * more would silently round and make the value non-reproducible across engines — in a
 * consensus rule that is a chain split, not a rounding error.
 */
export function drawUnit(beacon, shardId, hostId) {
    const h = sha256hex(String(beacon) + '|' + String(shardId) + '|' + String(hostId));
    const top = BigInt('0x' + h.slice(0, 14));        // 56 bits
    return Number(top >> 4n) / Math.pow(2, 52);       // keep the top 52
}

/** F14 weight: compute_class * honesty. Invalid or non-positive weights cannot be picked. */
export function hostWeight(host) {
    if (!host) return 0;
    const cc = Number(host.computeClass ?? host.compute_class ?? 1);
    const q = Number(host.q ?? 1);
    if (!isFinite(cc) || !isFinite(q) || cc <= 0 || q <= 0) return 0;
    return cc * Math.min(q, 1);
}

/**
 * Selection key. Larger wins.
 *
 * key = u^(1/w). Raising a value in [0,1) to a SMALLER exponent (bigger w) pushes it toward
 * 1, so heavier hosts systematically score higher without ever being guaranteed a slot.
 */
export function selectionKey(u, weight) {
    if (!(weight > 0)) return -1;                     // ineligible, never selected
    if (u <= 0) return 0;                             // degenerate draw, ranks last
    return Math.pow(u, 1 / weight);
}

/**
 * F14 — assign r replicas to one shard.
 *
 * @param {object} args
 * @param {string} args.beacon   epoch beacon from F17 (REQUIRED — no beacon, no assignment)
 * @param {string} args.shardId  shard identifier
 * @param {Array}  args.hosts    [{ id, computeClass, q }]
 * @param {number} args.r        replicas (default F6's R)
 * @returns {{assigned:string[], eligible:number, ranked:Array<{id,key,weight}>}}
 *          assigned is ordered by key descending, ties broken by id, so every node produces
 *          an identical list.
 */
export function assignShard({ beacon, shardId, hosts, r = ASSIGNMENT_DEFAULTS.R } = {}) {
    const empty = { assigned: [], eligible: 0, ranked: [] };
    // Without a beacon the draw would be predictable, which defeats the entire purpose.
    // Refuse rather than fall back to something guessable.
    if (!beacon || typeof beacon !== 'string') return empty;
    if (shardId === undefined || shardId === null) return empty;

    const list = (Array.isArray(hosts) ? hosts : []).filter(h => h && typeof h.id === 'string' && h.id);
    // One entry per id: a duplicated host must not get two chances at the same shard.
    const seen = new Set();
    const unique = [];
    for (const h of list) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        unique.push(h);
    }

    const ranked = unique.map(h => {
        const weight = hostWeight(h);
        return { id: h.id, weight, key: selectionKey(drawUnit(beacon, shardId, h.id), weight) };
    }).filter(x => x.weight > 0);

    ranked.sort((a, b) => {
        if (b.key !== a.key) return b.key - a.key;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;   // deterministic tie-break
    });

    const count = Math.max(0, Math.min(Math.floor(Number(r) || 0), ranked.length));
    return {
        assigned: ranked.slice(0, count).map(x => x.id),
        eligible: ranked.length,
        ranked
    };
}

/**
 * Assign every shard in an epoch. Convenience over assignShard, with the same guarantees.
 * @returns {{assignments: Object<string,string[]>, unassigned: string[]}}
 */
export function assignEpoch({ beacon, shards, hosts, r = ASSIGNMENT_DEFAULTS.R } = {}) {
    const assignments = {};
    const unassigned = [];
    const ids = (Array.isArray(shards) ? shards : []).map(String).sort();
    for (const shardId of ids) {
        const { assigned } = assignShard({ beacon, shardId, hosts, r });
        assignments[shardId] = assigned;
        // Fewer replicas than F6 requires means the Byzantine-majority guarantee does not
        // hold for that shard. Surface it rather than quietly accepting weaker security.
        if (assigned.length < r) unassigned.push(shardId);
    }
    return { assignments, unassigned };
}

/**
 * Verify a published assignment — the "verifiable-after" property. Anyone can call this
 * and prove no one cherry-picked their shard.
 */
export function verifyAssignment({ beacon, shardId, hosts, r, assigned } = {}) {
    const expected = assignShard({ beacon, shardId, hosts, r });
    const got = Array.isArray(assigned) ? assigned : [];
    return expected.assigned.length === got.length &&
           expected.assigned.every((id, i) => id === got[i]);
}
