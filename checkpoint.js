// ════════════════════════════════════════════════════════════════════════════════
// checkpoint.js — checkpoint availability + storage proofs   (F15, M3)
//
// The model's weights must stay retrievable while home PCs come and go. A checkpoint is
// erasure-coded into n chunks of which ANY k reconstruct it, its Merkle ROOT is committed
// on-chain so every node agrees on the one true model, and hosts are paid per chunk they
// can PROVE they still hold.
//
//     encode  : checkpoint -> n chunks, any k rebuild it   (k-of-n Reed-Solomon over GF(256))
//     commit  : Merkle root on-chain -> any chunk verifiable against the canonical state
//     prove   : random proof-of-retrievability challenge -> paid only if answered
//     size    : P(recover) = SUM_{j=k}^{n} C(n,j) p^j (1-p)^(n-j)  >=  1 - 1e-6
//
// WHY REED-SOLOMON AND NOT REPLICATION: storing r full copies costs r x the data to
// survive r-1 losses. A k-of-n code survives n-k losses at n/k x the data. For 10-of-16
// that is 1.6x overhead surviving 6 simultaneous departures — replication would need 7x.
// On a network of consumer PCs that leave without warning, the difference decides whether
// the model survives at all.
//
// GF(256) IS EXACT ARITHMETIC. Every operation here is over a finite field with lookup
// tables — there is no floating point anywhere, so decode either reproduces the original
// bytes exactly or fails loudly. That property is why erasure coding can be trusted with
// state that cannot be regenerated.
//
// PURE and DETERMINISTIC, like beacon.js / assignment.js / treasury.js.
// ════════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';

export const CHECKPOINT_DEFAULTS = {
    K: 10,              // chunks needed to reconstruct
    N: 16,             // chunks produced (survives 6 losses at 1.6x overhead)
    CHALLENGE_BYTES: 32
};

// ── GF(256) arithmetic — the field the code is built on ────────────────────────
// Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d), the standard choice.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;              // reduce modulo the primitive polynomial
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
const gfDiv = (a, b) => {
    if (b === 0) throw new Error('GF(256) division by zero');
    return a === 0 ? 0 : GF_EXP[GF_LOG[a] + 255 - GF_LOG[b]];
};
const gfInv = (a) => {
    if (a === 0) throw new Error('GF(256) has no inverse for zero');
    return GF_EXP[255 - GF_LOG[a]];
};

/**
 * Systematic encoding matrix: identity on top, Cauchy below.
 *
 * A CAUCHY matrix is used rather than Vandermonde because EVERY square submatrix of a
 * Cauchy matrix is guaranteed invertible. That is precisely the MDS property this needs:
 * whichever k chunks happen to survive, the decode matrix is invertible. With Vandermonde
 * that has to be argued case by case, and a non-invertible submatrix means unrecoverable
 * data despite k chunks being present — exactly the failure erasure coding exists to rule
 * out.
 *
 * Systematic form (identity rows first) means the first k chunks ARE the original data,
 * so an intact checkpoint costs nothing to read back.
 */
function encodeMatrix(k, n) {
    const rows = [];
    for (let i = 0; i < k; i++) {
        const row = new Uint8Array(k);
        row[i] = 1;
        rows.push(row);
    }
    // Cauchy: C[i][j] = 1 / (x_i XOR y_j), with the x set disjoint from the y set.
    for (let i = 0; i < n - k; i++) {
        const row = new Uint8Array(k);
        const xi = i + k + 1;                    // disjoint from y_j = 1..k
        for (let j = 0; j < k; j++) row[j] = gfInv(xi ^ (j + 1));
        rows.push(row);
    }
    return rows;
}

/** Gauss-Jordan inversion over GF(256). Throws if the matrix is singular. */
function invertMatrix(m, size) {
    const a = m.map(r => Uint8Array.from(r));
    const inv = [];
    for (let i = 0; i < size; i++) {
        const row = new Uint8Array(size);
        row[i] = 1;
        inv.push(row);
    }
    for (let col = 0; col < size; col++) {
        let pivot = -1;
        for (let r = col; r < size; r++) if (a[r][col] !== 0) { pivot = r; break; }
        if (pivot === -1) throw new Error('decode matrix is singular — chunk set cannot reconstruct');
        if (pivot !== col) {
            [a[col], a[pivot]] = [a[pivot], a[col]];
            [inv[col], inv[pivot]] = [inv[pivot], inv[col]];
        }
        const p = a[col][col];
        for (let j = 0; j < size; j++) {
            a[col][j] = gfDiv(a[col][j], p);
            inv[col][j] = gfDiv(inv[col][j], p);
        }
        for (let r = 0; r < size; r++) {
            if (r === col || a[r][col] === 0) continue;
            const f = a[r][col];
            for (let j = 0; j < size; j++) {
                a[r][j] ^= gfMul(f, a[col][j]);
                inv[r][j] ^= gfMul(f, inv[col][j]);
            }
        }
    }
    return inv;
}

/**
 * F15 — erasure-code a checkpoint into n chunks, any k of which reconstruct it.
 *
 * @param {Buffer|Uint8Array} data  the checkpoint bytes
 * @returns {{chunks:Array<{index:number,data:Buffer}>, k:number, n:number,
 *            originalLength:number, shardLength:number}}
 */
export function encodeCheckpoint(data, { k = CHECKPOINT_DEFAULTS.K, n = CHECKPOINT_DEFAULTS.N } = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (!(k > 0) || !(n > k)) throw new Error('need 0 < k < n');
    if (n > 255) throw new Error('GF(256) supports at most 255 chunks');
    if (buf.length === 0) throw new Error('refusing to encode an empty checkpoint');

    const shardLength = Math.ceil(buf.length / k);
    // Pad to a whole number of shards. originalLength is carried so decode trims exactly —
    // without it the rebuilt checkpoint would carry trailing zeros and hash differently.
    const padded = Buffer.alloc(shardLength * k, 0);
    buf.copy(padded);

    const matrix = encodeMatrix(k, n);
    const chunks = [];
    for (let i = 0; i < n; i++) {
        const out = Buffer.alloc(shardLength);
        const row = matrix[i];
        for (let j = 0; j < k; j++) {
            const coeff = row[j];
            if (coeff === 0) continue;
            const off = j * shardLength;
            for (let b = 0; b < shardLength; b++) out[b] ^= gfMul(coeff, padded[off + b]);
        }
        chunks.push({ index: i, data: out });
    }
    return { chunks, k, n, originalLength: buf.length, shardLength };
}

/**
 * Reconstruct from ANY k chunks.
 * @param {Array<{index:number,data:Buffer}>} chunks  at least k of them
 */
export function decodeCheckpoint(chunks, { k, n, originalLength } = {}) {
    const list = (Array.isArray(chunks) ? chunks : [])
        .filter(c => c && Number.isInteger(c.index) && c.data && c.data.length);
    if (!(k > 0) || !(n > k)) throw new Error('need 0 < k < n');

    // One chunk per index — a duplicate would make the decode matrix singular even though
    // k distinct chunks appear to be present.
    const byIndex = new Map();
    for (const c of list) if (!byIndex.has(c.index)) byIndex.set(c.index, c);
    const chosen = [...byIndex.values()].sort((a, b) => a.index - b.index).slice(0, k);
    if (chosen.length < k) {
        throw new Error(`need ${k} distinct chunks to reconstruct, got ${chosen.length}`);
    }

    const matrix = encodeMatrix(k, n);
    const sub = chosen.map(c => {
        if (c.index < 0 || c.index >= n) throw new Error(`chunk index ${c.index} is outside 0..${n - 1}`);
        return matrix[c.index];
    });
    const inv = invertMatrix(sub, k);

    const shardLength = chosen[0].data.length;
    for (const c of chosen) {
        if (c.data.length !== shardLength) throw new Error('chunks have inconsistent lengths');
    }

    const out = Buffer.alloc(shardLength * k);
    for (let i = 0; i < k; i++) {
        const row = inv[i];
        const off = i * shardLength;
        for (let j = 0; j < k; j++) {
            const coeff = row[j];
            if (coeff === 0) continue;
            const src = chosen[j].data;
            for (let b = 0; b < shardLength; b++) out[off + b] ^= gfMul(coeff, src[b]);
        }
    }
    return Number.isInteger(originalLength) ? out.subarray(0, originalLength) : out;
}

// ── Merkle commitment: the canonical on-chain root ─────────────────────────────
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const leafHash = (index, data) =>
    sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(String(index) + ':'), data]));
// Internal nodes are domain-separated with 0x01 so a leaf can never be reinterpreted as an
// internal node — the classic second-preimage attack on naive Merkle trees.
const nodeHash = (l, r) => sha256(Buffer.concat([Buffer.from([0x01]), l, r]));

function buildLevels(chunks) {
    const ordered = chunks.slice().sort((a, b) => a.index - b.index);
    let level = ordered.map(c => leafHash(c.index, c.data));
    const levels = [level];
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            // An odd node is promoted rather than duplicated: duplicating a node lets two
            // different chunk sets produce the SAME root (CVE-2012-2459 in Bitcoin).
            next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
        }
        levels.push(next);
        level = next;
    }
    return levels;
}

/** The root committed on-chain each epoch — the one true model every node agrees on. */
export function merkleRoot(chunks) {
    if (!Array.isArray(chunks) || !chunks.length) return null;
    const levels = buildLevels(chunks);
    return levels[levels.length - 1][0].toString('hex');
}

/** Proof that a chunk belongs to the committed checkpoint. */
export function merkleProof(chunks, index) {
    if (!Array.isArray(chunks) || !chunks.length) return null;
    const ordered = chunks.slice().sort((a, b) => a.index - b.index);
    let pos = ordered.findIndex(c => c.index === index);
    if (pos < 0) return null;
    const levels = buildLevels(ordered);
    const path = [];
    for (let l = 0; l < levels.length - 1; l++) {
        const level = levels[l];
        const sibling = (pos % 2 === 0) ? pos + 1 : pos - 1;
        if (sibling < level.length) {
            path.push({ hash: level[sibling].toString('hex'), right: sibling > pos });
        }
        pos = Math.floor(pos / 2);
    }
    return { index, path };
}

/** Verify a chunk against the on-chain root without holding the rest of the checkpoint. */
export function verifyChunk({ index, data, proof, root }) {
    if (!data || !proof || !root) return false;
    let h = leafHash(index, Buffer.isBuffer(data) ? data : Buffer.from(data));
    for (const step of (proof.path || [])) {
        const sib = Buffer.from(step.hash, 'hex');
        h = step.right ? nodeHash(h, sib) : nodeHash(sib, h);
    }
    return h.toString('hex') === root;
}

// ── Proof of retrievability: pay only for chunks a host can still produce ──────
/**
 * A challenge a host can only answer by actually holding the chunk. The nonce makes each
 * challenge unique, so a host cannot record one valid answer and replay it forever.
 */
export function makeChallenge(nonce = null) {
    return nonce || crypto.randomBytes(CHECKPOINT_DEFAULTS.CHALLENGE_BYTES).toString('hex');
}

/** The response: H(nonce || chunk). Requires the bytes, not just knowledge of the hash. */
export function answerChallenge(nonce, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    return sha256(Buffer.concat([Buffer.from(String(nonce)), buf])).toString('hex');
}

/**
 * Verify a storage proof. Both parts must hold:
 *   - the answer proves the host has the BYTES right now (fresh nonce, no replay), and
 *   - the Merkle proof proves those bytes are the chunk the network actually committed.
 * Checking only the first would pay a host for storing anything at all; only the second
 * would pay for a proof recorded once and replayed forever.
 */
export function verifyStorageProof({ nonce, index, data, answer, proof, root }) {
    if (!nonce || !answer) return false;
    if (answerChallenge(nonce, data) !== answer) return false;
    return verifyChunk({ index, data, proof, root });
}

// ── Sizing: choose n and k from real churn ─────────────────────────────────────
/**
 * P(recover) = SUM_{j=k}^{n} C(n,j) p^j (1-p)^(n-j), p = probability one chunk is available.
 * Log-factorials keep large n from overflowing the binomial coefficient.
 */
export function recoveryProbability(p, k, n) {
    const avail = Number(p);
    if (!(avail >= 0 && avail <= 1) || !(k > 0) || !(n >= k)) return NaN;
    if (avail === 1) return 1;
    if (avail === 0) return k === 0 ? 1 : 0;

    const logFact = new Array(n + 1).fill(0);
    for (let i = 2; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
    const logC = (a, b) => logFact[a] - logFact[b] - logFact[a - b];

    let total = 0;
    for (let j = k; j <= n; j++) {
        total += Math.exp(logC(n, j) + j * Math.log(avail) + (n - j) * Math.log(1 - avail));
    }
    return Math.min(1, Math.max(0, total));
}

/**
 * Smallest n meeting a durability target for a given k and chunk availability, so n is
 * derived from measured churn instead of guessed. Returns null if unreachable — an honest
 * failure beats a number that quietly misses the target.
 */
export function chooseN(p, k, target = 1 - 1e-6, maxN = 255) {
    for (let n = k; n <= maxN; n++) {
        if (recoveryProbability(p, k, n) >= target) return n;
    }
    return null;
}
