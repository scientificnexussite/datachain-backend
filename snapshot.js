// ════════════════════════════════════════════════════════════════════════════════
// snapshot.js — canonical, VERIFIABLE state snapshot   (the Railway hand-off)
//
// THE PROBLEM THIS SOLVES
// Balances, price history, the token registry and order books live in the primary's
// database and are NOT derivable from the chain. So a node cannot rebuild them by syncing
// blocks, and switching the primary off would destroy the only copy. Before the primary
// can go away, every node needs that state — and needs to be able to prove what it got is
// genuine.
//
// THE TRUST MODEL (the part that actually matters)
// A snapshot is serialized CANONICALLY and committed to a single Merkle ROOT. Every chunk
// carries a proof against that root, so:
//   - a node can verify each chunk INDEPENDENTLY, from any source, in any order;
//   - a malicious peer cannot alter one balance without breaking its proof;
//   - once the root is known, the DATA can come from anywhere — peers, a mirror, a USB
//     stick — because trust lives in the root, not in the transport.
//
// That last point is what makes the primary disposable. While it is still running it
// publishes the root; nodes pin it (ideally committed ON-CHAIN via epoch.js's CHECKPOINT
// transaction, which makes it permanent and consensus-visible). After that the network
// re-serves the same snapshot to newcomers forever, with no privileged source.
//
// ⚠️ WHAT THIS DOES *NOT* DO: it does not make the primary's numbers CORRECT. A snapshot
// faithfully commits whatever it is given, including drift. Run the integrity check first
// (integrity.js) — a snapshot of an inconsistent ledger permanently enshrines that
// inconsistency at a root every node will then treat as canonical.
//
// PURE and DETERMINISTIC: the same state produces byte-identical chunks and the same root
// on every machine, which is what lets independent nodes agree without coordination.
// ════════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { merkleRoot, merkleProof, verifyChunk } from './checkpoint.js';

export const SNAPSHOT_DEFAULTS = {
    CHUNK_BYTES: 512 * 1024,        // ~512KB per chunk: small enough to retry cheaply
    VERSION: 1
};

// Tables that make up the authoritative state a node cannot derive from blocks.
// ORDER IS PART OF THE CANONICAL FORM — changing it changes every root.
export const SNAPSHOT_TABLES = [
    'state_balances',
    'state_usd_balances',
    'token_metadata',
    'open_tokens',
    'state_liquidity_pools',
    'orders'
];

// DELIBERATELY NOT SNAPSHOTTED, and why — both were verified against the live primary:
//
//   price_history  — the table exists but holds ZERO rows. /pricehistory computes prices
//                    from the TRANSACTIONS table (`amount_usd / amount` on trades), and a
//                    node already rebuilds the same series while replaying blocks
//                    (state-db._recordTradePrice). Shipping the empty table made the
//                    snapshot report "0 price points" and looked like data loss when in
//                    fact the data was never there to copy.
//
//   liquidity_pools — WRONG NAME. The real table is `state_liquidity_pools` (state.js:23);
//                    the misspelled one does not exist, so pools silently came through as
//                    zero. This is exactly the failure mode a snapshot must not have: an
//                    unreadable table is logged as a warning and treated as empty, which
//                    produces a perfectly valid-looking snapshot of nothing.

/**
 * Deterministic JSON: object keys sorted at every level.
 *
 * JSON.stringify preserves insertion order, and two databases can return the same row with
 * columns in different orders. That alone would produce different bytes, a different root,
 * and nodes that disagree about identical state — so key order must be pinned here.
 */
export function canonicalJSON(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

/**
 * Canonical row ordering within a table. Rows arrive from SQL in whatever order the
 * planner chose; without a stable sort the same data yields a different root each export.
 */
function sortRows(rows) {
    return rows.slice().sort((a, b) => {
        const ka = canonicalJSON(a), kb = canonicalJSON(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

/**
 * Build a snapshot from raw table data.
 *
 * @param {object} args
 * @param {object} args.tables  { tableName: [row, ...] }
 * @param {number} args.height  chain height this snapshot corresponds to
 * @returns {{manifest:object, chunks:Array<{index:number,data:Buffer}>}}
 */
export function buildSnapshot({ tables = {}, height = 0, chunkBytes = SNAPSHOT_DEFAULTS.CHUNK_BYTES } = {}) {
    const parts = [];
    const counts = {};

    for (const name of SNAPSHOT_TABLES) {
        const rows = Array.isArray(tables[name]) ? tables[name] : [];
        counts[name] = rows.length;
        // One line per row (newline-delimited JSON): a chunk boundary can fall anywhere
        // without corrupting a record, and a reader can stream instead of buffering the
        // whole snapshot in memory.
        for (const row of sortRows(rows)) {
            parts.push(canonicalJSON({ t: name, r: row }));
        }
    }

    const body = Buffer.from(parts.join('\n'), 'utf8');
    const size = Math.max(1, Math.floor(Number(chunkBytes) || SNAPSHOT_DEFAULTS.CHUNK_BYTES));
    const chunks = [];
    for (let off = 0, i = 0; off < body.length || i === 0; off += size, i++) {
        chunks.push({ index: i, data: body.subarray(off, Math.min(off + size, body.length)) });
        if (off + size >= body.length) break;
    }

    const root = merkleRoot(chunks);
    return {
        manifest: {
            version: SNAPSHOT_DEFAULTS.VERSION,
            height: Number(height) || 0,
            root,
            chunkCount: chunks.length,
            // The EXACT chunk size, carried so anyone can reproduce the identical split.
            // Deriving it as totalBytes/chunkCount is wrong — the final chunk is short, so
            // that average re-splits the body at different offsets and every proof fails.
            chunkBytes: size,
            totalBytes: body.length,
            rowCounts: counts,
            // Hash of the whole body as well as the Merkle root: the root proves individual
            // chunks, this proves the ASSEMBLED result — catching a reassembly bug that
            // per-chunk proofs would each pass.
            bodyHash: crypto.createHash('sha256').update(body).digest('hex')
        },
        chunks
    };
}

/** Proof for one chunk against the snapshot root. */
export function chunkProof(chunks, index) {
    return merkleProof(chunks, index);
}

/** Verify one chunk against the manifest root — the check that makes any source safe. */
export function verifySnapshotChunk({ index, data, proof, root }) {
    return verifyChunk({ index, data, proof, root });
}

/**
 * Reassemble verified chunks and parse the snapshot.
 * Throws if anything is missing or the assembled body does not match `bodyHash`.
 */
export function parseSnapshot(chunks, manifest) {
    if (!manifest) throw new Error('a manifest is required to parse a snapshot');
    const byIndex = new Map();
    for (const c of (Array.isArray(chunks) ? chunks : [])) {
        if (c && Number.isInteger(c.index) && c.data) byIndex.set(c.index, c);
    }
    // Every chunk is required. Unlike a model checkpoint there is no erasure coding here:
    // a missing chunk means missing accounts, and silently importing a partial ledger
    // would be far worse than failing.
    const ordered = [];
    for (let i = 0; i < manifest.chunkCount; i++) {
        if (!byIndex.has(i)) throw new Error(`snapshot chunk ${i} of ${manifest.chunkCount} is missing`);
        ordered.push(Buffer.from(byIndex.get(i).data));
    }

    const body = Buffer.concat(ordered);
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    if (manifest.bodyHash && hash !== manifest.bodyHash) {
        throw new Error('assembled snapshot does not match the manifest hash — refusing to import');
    }

    const tables = {};
    for (const name of SNAPSHOT_TABLES) tables[name] = [];
    const text = body.toString('utf8');
    if (text.length) {
        for (const line of text.split('\n')) {
            if (!line) continue;
            let entry;
            try { entry = JSON.parse(line); } catch (e) { throw new Error('snapshot contains a malformed row'); }
            if (!entry || !entry.t || !(entry.t in tables)) continue;   // unknown table: ignore
            tables[entry.t].push(entry.r);
        }
    }
    return { tables, height: manifest.height, root: manifest.root };
}

/**
 * Recompute a snapshot's root from parsed tables and compare it to the manifest.
 *
 * This is the strongest available check and the one worth running before trusting a
 * snapshot from an untrusted peer: it proves the DATA reproduces the committed root, not
 * merely that the bytes someone sent were internally consistent.
 */
export function verifySnapshot({ tables, manifest }) {
    if (!manifest || !manifest.root) return false;
    const rebuilt = buildSnapshot({
        tables,
        height: manifest.height,
        chunkBytes: manifest.chunkBytes || SNAPSHOT_DEFAULTS.CHUNK_BYTES
    });
    return rebuilt.manifest.bodyHash === manifest.bodyHash;
}
