// ════════════════════════════════════════════════════════════════════════════════
// chain-rules.js — how THIS node (the primary) applies txrules.js on every path that accepts a
//                  block (consensus validation, sub-step 4.3, 2026-10-17).
//
// Pure helpers, no database, so Exe/tests can drive them: datachain.js (addBlock,
// resolveConflict, loading) and api.js (/submit-block) call them. The rules themselves live in
// txrules.js (twin of Exe/core/txrules.js); this file is only how the primary uses them:
//   - transactions are stored EXACTLY (a tx_json column): loading a block back from Postgres
//     used to keep only the mapped columns — fields like `url`, `targetKey`, `boundKey`,
//     `nonce`, `hash` were lost and empty ones were added, so no signature could be checked;
//   - a RULE INDEX (ids already mined, the key registry) over the WHOLE chain, because this node
//     keeps transaction data in memory for only its last 10 blocks;
//   - a block is checked on a COPY of the ledger and kept only if every transaction is accepted,
//     with the overspend floor (`floor`) from RULES_1_HEIGHT;
//   - a competing branch is adopted only if it can be verified: a pure extension of our chain is
//     dry-run on a copy; a fork that would replace rules-era history is REFUSED (this node has
//     no ledger journal to rewind with — fail closed, never trusted).
// ════════════════════════════════════════════════════════════════════════════════

import * as txrules from './txrules.js';

// Every data field of state.js's State (not its file path or save flags).
export const STATE_FIELDS = ['balances', 'usd_balances', 'liquidityPools', 'nodes', 'tokens', 'openTokens',
                             'openTokenSupply', 'epochReceipts', 'bonds', 'dex'];
// Settings a copy keeps by value (tests switch RULES_2 on and pin their own owner key).
const STATE_SETTINGS = ['rules2Height', 'dexOwnerKey'];

/**
 * A full, independent copy of a State. (addBlock's old working copy carried only balances and
 * USD balances and then REPLACED the live state with it, dropping pools, nodes, registries,
 * receipts and bonds from memory.)
 */
export function cloneState(state, StateClass) {
    const c = new StateClass();
    for (const f of STATE_FIELDS) if (state && state[f] !== undefined) c[f] = JSON.parse(JSON.stringify(state[f]));
    for (const s of STATE_SETTINGS) if (state && state[s] !== undefined) c[s] = state[s];
    return c;
}

/** A transaction as it went into the block: tx_json when stored, else rebuilt from the columns. */
export function txFromRow(row) {
    if (row && typeof row.tx_json === 'string' && row.tx_json) {
        try { const tx = JSON.parse(row.tx_json); if (tx && typeof tx === 'object') return tx; } catch (e) { /* fall back */ }
    }
    const tx = { from: row.from_address, to: row.to_address, amount: parseFloat(row.amount),
                 type: row.type, tokenSymbol: row.token_symbol, timestamp: parseInt(row.timestamp_ms) };
    if (row.amount_usd) tx.amountUsd = parseFloat(row.amount_usd);
    if (row.price_usd) tx.priceUsd = parseFloat(row.price_usd);
    if (row.is_system_generated) tx.isSystemGenerated = true;
    if (row.signature) tx.signature = row.signature;
    if (row.public_key) tx.publicKey = row.public_key;
    if (row.platform_type) tx.platformType = row.platform_type;
    if (row.description) tx.description = row.description;
    return tx;
}

/** Rows (block_index + transaction) grouped back into minimal blocks, for the rule index. */
export function blocksFromRows(rows) {
    const by = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
        const i = Number(r.block_index);
        if (!by.has(i)) by.set(i, { index: i, timestamp: Number(r.timestamp_ms) || 0, data: [] });
        by.get(i).data.push(txFromRow(r));
    }
    return [...by.values()].sort((a, b) => a.index - b.index);
}

/** A rules-era block's body must be what its hash commits to (merkle root recomputed from data). */
export function integrityOk(block) {
    if (!txrules.rulesActive(block.index)) return true;
    if (!block || typeof block.calculateMerkleRoot !== 'function' || typeof block.calculateHash !== 'function') return false;
    return block.merkleRoot === block.calculateMerkleRoot(block.data) && block.hash === block.calculateHash();
}

/**
 * The mempool transactions this node may put into the block it builds at `height`. From
 * RULES_1_HEIGHT: txrules.checkUserTx, no replay (earlier blocks or this batch), one key
 * registration per address. Before it, everything passes (this node's old behaviour).
 */
export function filterCandidates(txs, { height, timestamp, ctx = {} } = {}) {
    const list = Array.isArray(txs) ? txs : [];
    if (!txrules.rulesActive(height)) {
        // Before RULES_1_HEIGHT everything passes as before — except escrow (step 4.5): its book
        // starts at RULES_1_HEIGHT, so coins locked earlier could never be released or refunded.
        const isEscrow = (tx) => tx && /^ESCROW_/.test(String(tx.type));
        return { kept: list.filter(tx => !isEscrow(tx)),
                 dropped: list.filter(isEscrow).map(tx => ({ tx, why: `escrow is valid only from block ${txrules.RULES_1_HEIGHT}` })) };
    }
    const kept = [], dropped = [];
    const ids = new Set(), regs = new Set();
    for (const tx of list) {
        let why = txrules.checkUserTx(tx, { timestamp, index: height }, ctx);
        const id = why ? null : txrules.txId(tx);
        if (!why && ((ctx.seen && ctx.seen(id)) || ids.has(id))) why = 'already mined (replay)';
        if (!why && tx.type === 'KEY_REGISTER' && regs.has(tx.from)) why = 'this address is registered twice in this block';
        if (why) { dropped.push({ tx, why }); continue; }
        ids.add(id);
        if (tx.type === 'KEY_REGISTER') regs.add(tx.from);
        kept.push(tx);
    }
    return { kept, dropped };
}

/**
 * Apply a whole block to `state` (a COPY): every transaction must be accepted. `floor` from
 * RULES_1_HEIGHT; history below it replays as mined (isReplay, no refusals).
 * @returns {{ok:boolean, index?:number, why?:string}}
 */
export function applyBlockTo(state, block, { price = 0, replayBelowRules = true } = {}) {
    const strict = txrules.rulesActive(block.index);
    // Below RULES_1_HEIGHT: replay semantics (accept as mined) — or, for /submit-block, this
    // node's old behaviour of refusing what its ledger refuses (replayBelowRules = false).
    const refuse = strict || !replayBelowRules;
    // One-time ledger corrections for this height come first (step 4.4, D1).
    if (typeof state.applyCorrections === 'function') state.applyCorrections(block.index);
    const data = Array.isArray(block.data) ? block.data : [];
    for (let i = 0; i < data.length; i++) {
        const ok = state.applyTransaction(JSON.parse(JSON.stringify(data[i])), price, !refuse, { floor: strict, height: block.index });
        if (refuse && ok !== true) return { ok: false, index: i, why: 'the ledger refused it (overspend, or not allowed here)' };
    }
    return { ok: true };
}

/**
 * Check one block on top of the chain this index describes, against a COPY of `state`.
 * @returns {{ok:boolean, errors:Array<{index:number, why:string}>, state?:object}}  `state` = the copy, applied
 */
export function checkBlockOn(block, { index, state, StateClass, price = 0, replayBelowRules = true }) {
    const temp = cloneState(state, StateClass);
    if (txrules.rulesActive(block.index)) {
        if (!integrityOk(block)) return { ok: false, errors: [{ index: -1, why: 'the block body does not match its merkle root / hash' }] };
        const r = txrules.checkBlock(block, index.ctx());
        if (!r.ok) return { ok: false, errors: r.errors };
    }
    const a = applyBlockTo(temp, block, { price, replayBelowRules });
    if (!a.ok) return { ok: false, errors: [{ index: a.index, why: a.why }] };
    return { ok: true, errors: [], state: temp };
}

/**
 * May this node adopt a competing branch? `blocks` is the whole incoming chain, `forkAt` the
 * first index where it differs from ours, `ourLength` our chain's length, `ruleBlocks` our rule
 * index source (minimal blocks for the WHOLE chain), `state` our live state.
 * @returns {{ok:boolean, why?:string, block?:number, state?:object}}  `state` = the copy after the branch (pure extension)
 */
export function verifyBranch({ blocks, forkAt, ourLength, ruleBlocks, state, StateClass, price = 0 }) {
    const theirs = blocks.slice(forkAt);
    if (!theirs.some(b => txrules.rulesActive(b.index))) return { ok: true };
    if (forkAt < ourLength) {
        return { ok: false, block: theirs[0].index,
                 why: 'a fork that replaces our blocks cannot be verified on this node (no ledger journal); refused' };
    }
    const index = txrules.ruleIndex(ruleBlocks);
    let temp = state;
    for (const b of theirs) {
        const r = checkBlockOn(b, { index, state: temp, StateClass, price });
        if (!r.ok) return { ok: false, block: b.index, why: r.errors.map(e => (e.index >= 0 ? `tx ${e.index}: ` : '') + e.why).join('; ') };
        temp = r.state;
        index.add(b);
    }
    return { ok: true, state: temp };
}
