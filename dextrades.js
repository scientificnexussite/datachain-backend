// ════════════════════════════════════════════════════════════════════════════════
// dextrades.js — this node's history of on-chain market trades (seven-phase plan Step 5), for
//                GET /dex/trades/:token. The counterpart of the exe's dex_trades table.
//
// NOT CONSENSUS. A block is applied to a COPY of the ledger and the copy replaces the live state
// (datachain.js addBlock, api.js /submit-block). The copy starts with no trade events, so when it is
// committed its `dexEvents` are exactly that block's swaps and fills: recordBlockTrades() files them
// here (a ring per token, and Postgres when it is reachable) and empties the list.
// ════════════════════════════════════════════════════════════════════════════════

import pool from './db.js';

const KEEP = 500;                              // per token, in memory
const ring = new Map();                        // token -> [{ event, txHash, timestamp, block }] oldest first

pool.query(`CREATE TABLE IF NOT EXISTS dex_trades (
    id SERIAL PRIMARY KEY, block_index INT, tx_hash TEXT, token VARCHAR(20), data TEXT, timestamp_ms BIGINT
)`).catch(() => { /* no database: the in-memory ring still serves */ });

function remember(t) {
    const token = t.event.token;
    const list = ring.get(token) || [];
    list.push(t);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    ring.set(token, list);
}

/** File the trades of a block just committed (the state that block produced), then forget them there. */
export function recordBlockTrades(blockIndex, state) {
    const list = (state && Array.isArray(state.dexEvents)) ? state.dexEvents : [];
    for (const t of list) {
        const rec = Object.assign({ block: blockIndex }, t);
        remember(rec);
        pool.query('INSERT INTO dex_trades (block_index, tx_hash, token, data, timestamp_ms) VALUES ($1, $2, $3, $4, $5)',
                   [blockIndex, t.txHash || null, t.event.token, JSON.stringify(t.event), t.timestamp || Date.now()]).catch(() => {});
    }
    if (state) state.dexEvents = [];
}

/** The most recent trades of a token, newest first: [{ event, txHash, timestamp }]. */
export function recentTrades(token, limit = 50) {
    const n = Math.min(Math.max(1, Number(limit) || 50), KEEP);
    return (ring.get(String(token)) || []).slice(-n).reverse();
}

/** At start-up: refill the ring from Postgres (best effort). */
export async function loadRecentTrades() {
    try {
        const r = await pool.query('SELECT block_index, tx_hash, data, timestamp_ms FROM dex_trades ORDER BY id DESC LIMIT 5000');
        for (const row of r.rows.reverse()) {
            try { remember({ event: JSON.parse(row.data), txHash: row.tx_hash, timestamp: Number(row.timestamp_ms) || null, block: row.block_index }); }
            catch (e) { /* skip a damaged row */ }
        }
    } catch (e) { /* no database */ }
}
