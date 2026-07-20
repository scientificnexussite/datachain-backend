// ════════════════════════════════════════════════════════════════════════════════
// epoch.js — daily AI-Treasury settlement driver  (M1, roadmap 13_BUILD_ROADMAP)
//
// The treasury collects 13 SYR/block (F23). Once per daily epoch this driver turns that
// pool into actual host payouts using the pure engine in treasury.js, and emits them as
// ordinary TRANSFER transactions from the treasury address — so they are on-ledger,
// auditable, and subject to the ledger's own solvency check (state.js applyTransaction
// refuses a transfer the sender cannot cover).
//
// ── DORMANT ─────────────────────────────────────────────────────────────────────
// EPOCH_1_HEIGHT is MAX_SAFE_INTEGER, so no boundary is ever reached and this is a strict
// no-op on the live chain. It activates only when BOTH are true:
//   1. verified-work receipts exist on-ledger (M0 worker + F16 verified-work credit), and
//   2. a real EPOCH_1_HEIGHT is set with rollout margin, the same way the difficulty fork
//      is staged (DATACHAIN_DIFFICULTY_FORK.txt).
// Until then getVerifiedWorkReceipts() returns [] and every epoch settles to nothing.
//
// ── DETERMINISM ─────────────────────────────────────────────────────────────────
// Every node must build an identical batch (05 sec.2), so buildEpochTransactions is PURE:
// same height + balance + receipts + carried queue -> byte-identical transactions. The
// carried PENDING queue must therefore be derivable from the chain itself once receipts
// are on-ledger; the in-memory copy DataChain holds today is a cache of that derivation,
// which is safe only while the feature is dormant.
// ════════════════════════════════════════════════════════════════════════════════

import { buildEpochBatch, PRIORITY } from './treasury.js';

// Activation height — MAX_SAFE_INTEGER = dormant. See the DORMANT note above.
export const EPOCH_1_HEIGHT = Number.MAX_SAFE_INTEGER;

// F2: settlement period is daily. At the 10s target block time that is 8,640 blocks.
export const EPOCH_BLOCKS = 8640;

/** True when this height closes an epoch AND epoch settlement has activated. */
export function isEpochBoundary(height) {
    const h = Number(height);
    if (!Number.isFinite(h) || h < EPOCH_1_HEIGHT) return false;
    return h > 0 && h % EPOCH_BLOCKS === 0;
}

/** Monotonic epoch number for a height (epoch 1 is the first completed epoch). */
export function epochNumber(height) {
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0) return 0;
    return Math.floor(h / EPOCH_BLOCKS);
}

/**
 * Verified-work receipts for an epoch: [{ address, f, q, u, home }].
 *
 * NOT IMPLEMENTED YET — this is the M0/F16 hand-off. Receipts must be produced by the
 * worker protocol (verified FLOPs f, honesty q from audit challenges, uptime u from
 * heartbeats) and committed on-ledger so every node reads the SAME set. Returning []
 * keeps settlement a no-op, which is why the feature is safe to ship dormant.
 */
export function getVerifiedWorkReceipts(/* chain, epoch */) {
    return [];
}

/**
 * PURE — build the payout transactions for one epoch boundary.
 *
 * @param {object} args
 * @param {number} args.height           height of the block closing the epoch
 * @param {number} args.treasuryBalance  SYR the treasury address actually holds
 * @param {string} args.treasuryAddress  the keyless treasury address
 * @param {number} args.epochPool        SYR that accrued to the treasury this epoch
 * @param {Array}  args.receipts         verified-work receipts for this epoch
 * @param {Array}  args.carriedPending   obligations earlier epochs could not cover
 * @returns {{txs: Array, pending: Array, summary: object}}
 */
export function buildEpochTransactions({ height, treasuryBalance = 0, treasuryAddress,
                                          epochPool = 0, receipts = [], carriedPending = [] } = {}) {
    const epoch = epochNumber(height);
    const empty = { txs: [], pending: Array.isArray(carriedPending) ? carriedPending : [], summary: null };
    if (!treasuryAddress) return empty;

    const batch = buildEpochBatch({
        epoch,
        balance: treasuryBalance,
        epochPool,
        hosts: receipts,
        carriedPending
    });

    // Deterministic: buildEpochBatch pays in a fixed (priority, age, id) order, so the
    // transaction list below is identical on every node.
    const txs = batch.payouts.map(o => ({
        from: treasuryAddress,
        to: o.address,
        amount: o.amount,
        type: "TRANSFER",
        tokenSymbol: "SYR",
        timestamp: 0,                     // set by the caller from the block timestamp
        isSystemGenerated: true,
        description: "AI Work Reward (epoch " + epoch + ")"
    }));

    return {
        txs,
        // obligations[i] is the debt that produced txs[i] — lets the caller re-queue a payout
        // if the ledger rejects it, instead of dropping a host's debt on the floor.
        obligations: batch.payouts,
        pending: batch.pending,
        summary: {
            epoch,
            height: Number(height),
            paidCount: batch.payouts.length,
            totalPaid: batch.totalPaid,
            pendingCount: batch.pending.length,
            pendingTotal: batch.pending.reduce((s, o) => s + (Number(o.amount) || 0), 0),
            balanceAfter: batch.balanceAfter
        }
    };
}

export { PRIORITY };
