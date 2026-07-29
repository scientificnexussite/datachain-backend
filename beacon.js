// ════════════════════════════════════════════════════════════════════════════════
// beacon.js — verifiable random beacon   (F17, M3)
//
// F14 decides which hosts compute which shard from a per-epoch random value. That value
// must be UNGRINDABLE: if anyone can steer it, they can pre-position on a target shard or
// dodge audits, and the whole anti-collusion story collapses (09/R35). The block hash is
// NOT usable — miners grind it by construction.
//
//   beacon_e = DELAY( XOR_i reveal_i )
//
// Protocol:
//   1. COMMIT   each committee member publishes H(reveal_i) before the round opens.
//   2. REVEAL   members publish reveal_i; only reveals matching their commit are counted.
//   3. DELAY    the XOR is passed through a sequential delay function whose runtime
//               exceeds the reveal window.
//
// WHY THE DELAY STEP EXISTS: XOR alone is grindable by the LAST revealer, who sees every
// other reveal and can choose to withhold theirs, picking between two possible outcomes.
// The delay makes the outcome uncomputable inside the reveal window, so that choice is
// blind. Non-revealers are reported for slashing, which prices the attempt.
//
// ⚠️ HONEST LIMITATION — THIS IS A SEQUENTIAL DELAY FUNCTION, NOT A SUCCINCT VDF.
// It gives the security property that matters here (the output cannot be computed inside
// the reveal window) because evaluation is inherently sequential. What it does NOT give is
// cheap verification: a true VDF (Wesolowski / Pietrzak, over RSA or class groups) is
// verifiable in microseconds regardless of T, whereas verifying this costs the SAME as
// computing it. That is acceptable while the committee is small and T is modest, and it is
// honest about the tradeoff — but it MUST be replaced before verification cost matters at
// scale. Do not describe this as a VDF in public material.
//
// PURE and DETERMINISTIC, like powpolicy.js / treasury.js / verify.js: every node computes
// the same beacon from the same commits and reveals.
// ════════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';

export const BEACON_DEFAULTS = {
    // Sequential hash iterations. Must take longer than the reveal window on the FASTEST
    // plausible attacker machine, so a withholding revealer cannot evaluate their options.
    // Calibrate against real hardware before relying on it (same discipline as the
    // difficulty fork's SEED_D — a guessed constant is not a security parameter).
    DELAY_ITERATIONS: 100000,
    REVEAL_BYTES: 32
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

/** A fresh random reveal value. Each member keeps this secret until the reveal phase. */
export function newReveal() {
    return crypto.randomBytes(BEACON_DEFAULTS.REVEAL_BYTES).toString('hex');
}

/** commit = H(reveal). Published BEFORE the round so the reveal cannot be chosen later. */
export function commitment(reveal) {
    if (!isHex64(reveal)) throw new Error('reveal must be 32 bytes of hex');
    return sha256(Buffer.from(reveal, 'hex')).toString('hex');
}

/** Does this reveal match the commitment published earlier? */
export function verifyCommitment(commit, reveal) {
    if (!isHex64(commit) || !isHex64(reveal)) return false;
    // Fixed-length hex compared in constant time — avoids leaking position on mismatch.
    const a = Buffer.from(commitment(reveal), 'hex');
    const b = Buffer.from(commit, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * XOR every valid reveal together.
 *
 * XOR is ORDER-INDEPENDENT, which is exactly what a distributed protocol needs: nodes see
 * reveals in different orders and must still agree. And a single honest contributor is
 * enough to randomise the result — an attacker controlling every other member still cannot
 * determine the output.
 */
export function mixReveals(reveals) {
    const out = Buffer.alloc(BEACON_DEFAULTS.REVEAL_BYTES, 0);
    let used = 0;
    for (const r of (Array.isArray(reveals) ? reveals : [])) {
        if (!isHex64(r)) continue;
        const b = Buffer.from(r, 'hex');
        for (let i = 0; i < out.length; i++) out[i] ^= b[i];
        used++;
    }
    return { mixed: out.toString('hex'), used };
}

/**
 * Sequential delay function: iterated SHA-256. Each step depends on the previous one, so
 * it cannot be parallelised — that inherent sequentiality is the security property.
 * See the limitation note at the top of this file before trusting it at scale.
 */
export function delay(seedHex, iterations = BEACON_DEFAULTS.DELAY_ITERATIONS) {
    if (!isHex64(seedHex)) throw new Error('seed must be 32 bytes of hex');
    const n = Math.max(1, Math.floor(Number(iterations) || 0));
    let h = Buffer.from(seedHex, 'hex');
    for (let i = 0; i < n; i++) h = sha256(h);
    return h.toString('hex');
}

/**
 * Compute the epoch beacon from a committee's commits and reveals.
 *
 * @param {object} args
 * @param {Array}  args.commits  [{ id, commit }] published before the round
 * @param {Array}  args.reveals  [{ id, reveal }] published during the reveal window
 * @returns {{beacon:string|null, contributors:string[], missing:string[], invalid:string[],
 *            mixed:string, iterations:number}}
 *          `missing` and `invalid` are the slashing list (F6's economic backstop): a member
 *          who commits and then does not reveal — or reveals something that does not match
 *          — is exactly the withholding attacker this protocol exists to price.
 */
export function computeBeacon({ commits, reveals, iterations = BEACON_DEFAULTS.DELAY_ITERATIONS } = {}) {
    const commitList = Array.isArray(commits) ? commits : [];
    const revealList = Array.isArray(reveals) ? reveals : [];

    const revealById = new Map();
    for (const r of revealList) {
        // First reveal per id wins; a member cannot submit several and pick afterwards.
        if (r && typeof r.id === 'string' && !revealById.has(r.id)) revealById.set(r.id, r.reveal);
    }

    const contributors = [], missing = [], invalid = [], good = [];
    // Sorted by id so every node produces identical lists (consensus, and slashing lists
    // must match byte for byte).
    const sorted = commitList
        .filter(c => c && typeof c.id === 'string' && isHex64(c.commit))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const c of sorted) {
        if (!revealById.has(c.id)) { missing.push(c.id); continue; }
        const reveal = revealById.get(c.id);
        if (!verifyCommitment(c.commit, reveal)) { invalid.push(c.id); continue; }
        contributors.push(c.id);
        good.push(reveal);
    }

    const { mixed, used } = mixReveals(good);
    // No valid reveal means no randomness at all. Returning a beacon derived from nothing
    // would be a FIXED, fully predictable value — worse than none, because it looks valid.
    if (used === 0) {
        return { beacon: null, contributors, missing, invalid, mixed: null, iterations: 0 };
    }
    return {
        beacon: delay(mixed, iterations),
        contributors, missing, invalid, mixed,
        iterations: Math.max(1, Math.floor(Number(iterations) || 0))
    };
}

/**
 * Recompute a published beacon from the same inputs and check it matches.
 * Verification currently costs as much as computation — see the limitation note.
 */
export function verifyBeacon({ commits, reveals, iterations, beacon } = {}) {
    if (!isHex64(beacon)) return false;
    const r = computeBeacon({ commits, reveals, iterations });
    return r.beacon === beacon;
}
