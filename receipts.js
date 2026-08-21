// ════════════════════════════════════════════════════════════════════════════════
// receipts.js — verified-work receipts, ON-LEDGER  (M1, roadmap 13_BUILD_ROADMAP)
//
// THE GAP THIS CLOSES. 13_BUILD_ROADMAP M1 says what is still missing:
//     "receipts must be committed ON-LEDGER so every node validates the same set"
// verify.js already PRODUCES receipts (buildReceipts → [{address,f,q,u,home}], already
// address-sorted) and treasury.js already CONSUMES that exact shape. Nothing carried them
// between the two, so epoch.getVerifiedWorkReceipts() returned [] and the treasury paid
// nobody. This module is that carrier.
//
// ── WHY ON-LEDGER AND NOT JUST GOSSIPED ─────────────────────────────────────────
// A receipt causes SYR to be paid. If nodes learned receipts from the network rather than
// from the chain, two nodes could hold different sets, settle different amounts, and build
// different blocks — a fork over money. On-chain, the receipt set for an epoch is whatever
// the chain says it is, and every node reaches the same answer by construction.
//
// ── WHO MAY ISSUE ONE (owner decision) ──────────────────────────────────────────
// A VERIFIER QUORUM: several independent checkers must sign the same batch. A host cannot
// pay itself, because it cannot produce other people's signatures. This mirrors F6, where
// a shard result is only credited if independent replicas agree — the same principle one
// level up.
//
// ⚠️ HONEST LIMIT. There is no verifier REGISTRY yet, so "independent" here means
// "distinct public keys that signed". Distinct keys are cheap to mint, so this resists an
// honest mistake and a lazy attacker, NOT a determined one. The real backstop is a staked,
// registered verifier set — future work, and it must land before payouts are switched on
// (EPOCH_1_HEIGHT). Do not describe this as sybil-resistant until then.
// ════════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { merkleRoot } from './checkpoint.js';

export const RECEIPT_DEFAULTS = {
    // Distinct verifier signatures required before a batch counts.
    //
    // F6's rule is floor(r/2)+1 over the REPLICAS that took part (verify.js decideShard).
    // The same majority rule cannot be applied here yet because there is no registered
    // verifier set to take a majority OF. Three is the smallest number where no single
    // party is decisive and one failure still leaves agreement — the same floor used for
    // serving-reward witnesses. Replace with floor(r/2)+1 once a registry exists.
    MIN_VERIFIERS: 3,

    // A block carries the whole batch, so an unbounded array is a denial-of-service vector.
    // 10k hosts is far past any plausible near-term network and still only a few hundred kB.
    MAX_RECEIPTS: 10000,

    // Same reasoning for signatures.
    MAX_ATTESTATIONS: 64
};

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const inUnit = (x) => isNum(x) && x >= 0 && x <= 1;

/**
 * The exact bytes a verifier signs.
 *
 * ⚠️ CANONICAL — every node must reproduce this byte-for-byte or signatures verify on one
 * node and fail on another, which is a fork. Three rules make it canonical:
 *   1. receipts are SORTED by address here rather than trusted to arrive sorted;
 *   2. every field is written in a fixed order, so key order cannot vary;
 *   3. only the five consensus fields are included — anything else a producer attaches is
 *      deliberately NOT signed and therefore cannot change the meaning of the batch.
 */
export function canonicalPayload({ epoch, receipts }) {
    const list = (Array.isArray(receipts) ? receipts : [])
        .map(r => ({
            address: String(r && r.address || ''),
            f: Number(r && r.f) || 0,
            q: Number(r && r.q) || 0,
            u: Number(r && r.u) || 0,
            home: !!(r && r.home)
        }))
        .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

    // JSON.stringify over an array of literals with a fixed key order is deterministic in
    // every JS engine (ECMA-262 fixes both property order for literals and Number→String).
    return Buffer.from(JSON.stringify({
        v: 1,
        epoch: Number(epoch) || 0,
        receipts: list.map(r => [r.address, r.f, r.q, r.u, r.home])
    }), 'utf8');
}

/** Sign a batch as a verifier. `privateKeyPem` is an ECDSA P-256 key, as wallet.js issues. */
export function signBatch({ epoch, receipts, privateKeyPem }) {
    const s = crypto.createSign('SHA256');
    s.update(canonicalPayload({ epoch, receipts }));
    return s.sign(privateKeyPem, 'hex');
}

/**
 * Check the quorum on a batch.
 *
 * Returns the accepted signer list rather than a bare boolean, so a caller can say WHO
 * attested — a rejection that cannot name what was missing is a rejection nobody can fix.
 *
 * @returns {{ok:boolean, reason:string|null, signers:string[], required:number}}
 */
export function verifyAttestations({ epoch, receipts, attestations, params = {} } = {}) {
    const p = Object.assign({}, RECEIPT_DEFAULTS, params);
    const required = Math.max(1, Math.floor(p.MIN_VERIFIERS));
    const list = Array.isArray(attestations) ? attestations : [];

    if (list.length > p.MAX_ATTESTATIONS) {
        return { ok: false, reason: 'too-many-attestations', signers: [], required };
    }

    const payload = canonicalPayload({ epoch, receipts });

    // ONE VOTE PER KEY. Without this, a single verifier signing three times reaches a
    // "quorum" of three on its own — which would make the whole quorum decorative.
    // First occurrence wins, mirroring decideShard's duplicate handling (verify.js:100).
    const seen = new Set();
    const signers = [];
    for (const a of list) {
        if (!a || typeof a.verifier !== 'string' || typeof a.signature !== 'string') continue;
        if (seen.has(a.verifier)) continue;
        seen.add(a.verifier);

        let valid = false;
        try {
            const v = crypto.createVerify('SHA256');
            v.update(payload);
            valid = v.verify(a.verifier, a.signature, 'hex');
        } catch (e) {
            valid = false;      // malformed key or signature — not an attestation
        }
        if (valid) signers.push(a.verifier);
    }

    signers.sort();             // deterministic order for anything that records them
    if (signers.length < required) {
        return { ok: false, reason: 'insufficient-quorum', signers, required };
    }
    return { ok: true, reason: null, signers, required };
}

/**
 * Structural check on the batch itself, independent of who signed it.
 * Split from the quorum check so a malformed batch and an under-signed one are
 * distinguishable — they need different fixes.
 */
export function validateBatch({ epoch, receipts, params = {} } = {}) {
    const p = Object.assign({}, RECEIPT_DEFAULTS, params);

    const e = Number(epoch);
    if (!Number.isInteger(e) || e <= 0) return { ok: false, reason: 'bad-epoch' };
    if (!Array.isArray(receipts)) return { ok: false, reason: 'receipts-not-array' };
    if (receipts.length === 0) return { ok: false, reason: 'empty-batch' };
    if (receipts.length > p.MAX_RECEIPTS) return { ok: false, reason: 'too-many-receipts' };

    let prev = null;
    const seen = new Set();
    for (const r of receipts) {
        if (!r || typeof r.address !== 'string' || !r.address) return { ok: false, reason: 'bad-address' };

        // f is a FLOP count: non-negative and finite. q and u are ratios in [0,1] — a q of
        // 2 would double a host's share of the pool, so the bound is load-bearing, not
        // cosmetic.
        if (!isNum(r.f) || r.f < 0) return { ok: false, reason: 'bad-f' };
        if (!inUnit(r.q)) return { ok: false, reason: 'bad-q' };
        if (!inUnit(r.u)) return { ok: false, reason: 'bad-u' };

        // One receipt per address, and sorted. Both are required for a canonical batch:
        // duplicates would let a host be paid twice from one batch, and an unsorted batch
        // would hash differently on different nodes.
        if (seen.has(r.address)) return { ok: false, reason: 'duplicate-address' };
        seen.add(r.address);
        if (prev !== null && r.address < prev) return { ok: false, reason: 'not-sorted' };
        prev = r.address;
    }
    return { ok: true, reason: null };
}

/**
 * Build the RECEIPT transaction for one epoch.
 *
 * ONE transaction carrying the WHOLE batch, not one per host. Three reasons:
 *   · verify.js already emits an address-sorted array, so the batch is canonical as-is;
 *   · it is a single thing to validate and a single thing to sign;
 *   · mempool.js dedupes on (from,to,amount,type) — per-host receipts share all four and
 *     would collide as duplicates. One batch has nothing to collide with.
 */
export function buildReceiptTransaction({ epoch, receipts, attestations, treasuryAddress }) {
    if (!treasuryAddress) return null;
    const list = (Array.isArray(receipts) ? receipts : [])
        .slice()
        .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

    return {
        from: treasuryAddress,
        to: treasuryAddress,
        // EXPLICIT ZERO, never undefined: datachain.js drops any transaction whose amount
        // parses as NaN, so an absent amount would silently delete the batch.
        amount: 0,
        type: 'RECEIPT',
        tokenSymbol: 'SYR',
        epoch: Number(epoch) || 0,
        receipts: list,
        attestations: Array.isArray(attestations) ? attestations : [],
        timestamp: 0,                 // set by the caller from the block timestamp
        isSystemGenerated: true,
        description: 'Verified Work Receipts (epoch ' + (Number(epoch) || 0) + ')'
    };
}

/**
 * Read an epoch's receipts back OUT of the chain.
 *
 * The other half of committing them, and modelled on epoch.latestCommittedRoots: a node
 * learns the receipt set from the chain it already verified by proof-of-work, so it needs
 * to trust no server, no peer, and no coordinator for the numbers that decide payment.
 *
 * Scans NEWEST FIRST and takes the first match, so a later correction supersedes an earlier
 * batch for the same epoch rather than both counting.
 *
 * @param {Array} chain   blocks, oldest first
 * @param {number} epoch
 * @returns {Array} the receipts, or [] when that epoch has none
 */
export function receiptsForEpoch(chain, epoch) {
    if (!Array.isArray(chain)) return [];
    const want = Number(epoch);
    if (!Number.isInteger(want) || want <= 0) return [];

    for (let i = chain.length - 1; i >= 0; i--) {
        const block = chain[i];
        const txs = (block && Array.isArray(block.data)) ? block.data : [];
        for (const tx of txs) {
            if (!tx || String(tx.type).toUpperCase() !== 'RECEIPT') continue;
            if ((Number(tx.epoch) || 0) !== want) continue;
            return Array.isArray(tx.receipts) ? tx.receipts : [];
        }
    }
    return [];
}

// ── The pending-payment queue ───────────────────────────────────────────────────
//
// THE BUG THIS EXISTS TO FIX. datachain.js held `treasuryPending` in memory only — never
// persisted, never in the snapshot, never rebuilt on replay. A restart reset it to empty,
// so two nodes with different uptimes carried different debts and built different blocks.
// Harmless only while settlement is dormant; a fork the moment receipts are real.
//
// The fix mirrors the state snapshot: commit a ROOT on-chain, carry the LIST out of band,
// and refuse any list that does not hash to the committed root. A root proves a list is
// the right one; it cannot reconstruct it, which is why both halves are needed.

/** Canonical bytes for one obligation. Field order fixed, so the root is reproducible. */
function obligationLeaf(o) {
    return Buffer.from(JSON.stringify([
        String(o && o.id || ''),
        String(o && o.address || ''),
        Number(o && o.amount) || 0,
        Number(o && o.priority) || 0,
        Number(o && o.since) || 0
    ]), 'utf8');
}

/**
 * Merkle root of the pending queue, or null when nothing is owed.
 *
 * Sorted by id first: settleQueue already pays in a deterministic (priority, age, id) order,
 * but the ROOT must not depend on that ordering surviving a round trip through a peer.
 * Reuses checkpoint.merkleRoot, which domain-separates leaves from internal nodes and
 * PROMOTES an odd node rather than duplicating it (duplication is CVE-2012-2459, where two
 * different lists produce the same root).
 */
export function pendingRoot(pending) {
    const list = (Array.isArray(pending) ? pending : []).filter(o => o && o.address);
    if (list.length === 0) return null;

    const ordered = list.slice().sort((a, b) => {
        const ia = String(a.id || ''), ib = String(b.id || '');
        return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
    return merkleRoot(ordered.map((o, index) => ({ index, data: obligationLeaf(o) })));
}

/**
 * Does this list match the root committed on-chain?
 *
 * An empty queue and a committed root of null agree — that is a real state, not a failure.
 * Everything else must hash equal, so a peer cannot hand a node a queue with one debt
 * quietly added, removed, or re-addressed.
 */
export function verifyPendingList(pending, committedRoot) {
    const root = pendingRoot(pending);
    if (!committedRoot) return root === null;
    return typeof root === 'string' && root === String(committedRoot).toLowerCase();
}
