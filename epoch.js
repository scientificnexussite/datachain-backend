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
import { receiptsForEpoch, pendingRoot } from './receipts.js';

/**
 * A checkpoint root is only committed if it is a well-formed 32-byte hash.
 * Committing a malformed root would be worse than committing none: nodes would "agree" on
 * a canonical state that no chunk can ever be proven against, and every storage proof
 * would fail for a reason nobody could see.
 */
function normaliseRoot(root) {
    if (typeof root !== 'string') return null;
    const r = root.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(r) ? r : null;
}

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
 * Read straight off the CHAIN, so every node settling this epoch reads the same set — the
 * property M1 named as missing. The receipts are produced by verify.js (F6 redundancy, F16
 * credit, the honesty rule) and committed by a verifier quorum in a RECEIPT transaction;
 * this is only the reader.
 *
 * Returns [] when the epoch has no committed batch, which keeps settlement a no-op — the
 * same safe default the stub had, now for a real reason rather than for lack of an
 * implementation.
 *
 * ⚠️ Still gated by EPOCH_1_HEIGHT. Committing and reading receipts is deliberately
 * SEPARATE from paying on them: turning payouts on needs rollout margin and real worker
 * output from M0, so isEpochBoundary() stays false until that decision is made.
 */
export function getVerifiedWorkReceipts(chain, epoch) {
    return receiptsForEpoch(chain, epoch);
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
                                          epochPool = 0, receipts = [], carriedPending = [],
                                          storage = [], checkpointRoot = null,
                                          snapshotRoot = null } = {}) {
    const epoch = epochNumber(height);
    const empty = { txs: [], pending: Array.isArray(carriedPending) ? carriedPending : [], summary: null };
    if (!treasuryAddress) return empty;

    const batch = buildEpochBatch({
        epoch,
        balance: treasuryBalance,
        epochPool,
        hosts: receipts,
        carriedPending,
        storage
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
        description: (o.priority === PRIORITY.STORAGE
            ? "Checkpoint Storage Reward (epoch " + epoch + ", " + (o.chunks || 0) + " chunks)"
            : "AI Work Reward (epoch " + epoch + ")")
    }));

    // F15 — commit the checkpoint's Merkle root ON-CHAIN, FIRST in the block.
    //
    // Ordering is deliberate: the commitment is what makes the epoch's model state
    // canonical, and it must not be lost if the payout list is truncated or a payout is
    // rejected. It carries no value and is validated by state.js on its own terms.
    const commitment = normaliseRoot(checkpointRoot);
    const stateCommitment = normaliseRoot(snapshotRoot);

    // ── THE PENDING QUEUE'S ROOT ───────────────────────────────────────────────────
    // The queue of debts this epoch could not cover used to live ONLY in memory
    // (datachain.js treasuryPending) — never persisted, never in the snapshot, never
    // rebuilt on replay. A restart reset it to empty, so two nodes with different uptimes
    // carried different debts and would build different blocks. Committing its root makes
    // the queue verifiable: a node can be handed the list by any peer and reject it unless
    // it hashes to what the chain says.
    //
    // Computed from the batch's OUTPUT pending list, so the commitment describes the state
    // the epoch actually ended in.
    const pendingCommitment = pendingRoot(batch.pending);

    if (commitment || stateCommitment || pendingCommitment) {
        txs.unshift({
            from: treasuryAddress,
            to: treasuryAddress,
            amount: 0,
            type: "CHECKPOINT",
            tokenSymbol: "SYR",
            // The model checkpoint. `root` stays the primary field for backward
            // compatibility with anything already reading it.
            root: commitment || stateCommitment,
            // The STATE SNAPSHOT root (snapshot.js). Committing it here is what removes the
            // last trust gap in the hand-off: a brand-new node reads the canonical root
            // straight off the chain and needs to trust NO server for it — not the primary,
            // not a peer. Without this, the first sync has to trust whoever answers.
            snapshotRoot: stateCommitment || null,
            checkpointRoot: commitment || null,
            // The PENDING-PAYMENT QUEUE root. null is a real value meaning "nothing is
            // owed", not "unknown" — verifyPendingList treats an empty list and a null root
            // as agreeing, so a node cannot be handed phantom debts for a settled epoch.
            pendingRoot: pendingCommitment || null,
            epoch,
            timestamp: 0,
            isSystemGenerated: true,
            description: (commitment && stateCommitment)
                ? "Model Checkpoint + State Root (epoch " + epoch + ")"
                : (commitment ? "Model Checkpoint Root (epoch " + epoch + ")"
                              : (stateCommitment ? "State Snapshot Root (epoch " + epoch + ")"
                                                 : "Pending Queue Root (epoch " + epoch + ")"))
        });
    }

    return {
        txs,
        // obligations[i] is the debt that produced txs[i] — lets the caller re-queue a payout
        // if the ledger rejects it, instead of dropping a host's debt on the floor.
        //
        // The CHECKPOINT tx carries no debt, so a null is held in its slot to keep this
        // index-aligned with `txs`. Without the placeholder every obligation would be
        // shifted by one and a rejected payout would re-queue the WRONG host's debt.
        // ⚠️ COUNT THE PREPENDED TRANSACTIONS, DO NOT HARD-CODE ONE.
        // This used to test a single condition and prepend a single null. The moment a
        // second commitment transaction could be unshifted, every obligation shifted by one
        // and a rejected payout re-queued the WRONG host's debt — money moved to the wrong
        // account with nothing to show it had gone astray. Deriving the placeholder count
        // from the same condition that builds the transactions keeps them in step.
        obligations: (commitment || stateCommitment || pendingCommitment)
            ? [null].concat(batch.payouts)
            : batch.payouts,
        pending: batch.pending,
        checkpointRoot: commitment,
        snapshotRoot: stateCommitment,
        pendingRoot: pendingCommitment,
        summary: {
            epoch,
            height: Number(height),
            paidCount: batch.payouts.length,
            totalPaid: batch.totalPaid,
            pendingCount: batch.pending.length,
            pendingTotal: batch.pending.reduce((s, o) => s + (Number(o.amount) || 0), 0),
            balanceAfter: batch.balanceAfter,
            checkpointCommitted: !!commitment,
            snapshotCommitted: !!stateCommitment,
            storagePaid: batch.payouts.filter(o => o.priority === PRIORITY.STORAGE).length
        }
    };
}

/**
 * Read the most recently committed roots back OUT of the chain.
 *
 * This is the other half of committing them: a node bootstrapping from scratch scans the
 * chain it already verified by proof-of-work and learns the canonical state-snapshot root
 * WITHOUT trusting any server to tell it. Whoever then serves the snapshot bytes is
 * irrelevant, because a forged snapshot cannot match this root.
 *
 * @param {Array} chain  blocks, oldest first
 * @returns {{snapshotRoot:string|null, checkpointRoot:string|null, epoch:number, height:number}|null}
 */
export function latestCommittedRoots(chain) {
    if (!Array.isArray(chain)) return null;
    // Newest first: the most recent commitment wins.
    for (let i = chain.length - 1; i >= 0; i--) {
        const block = chain[i];
        const txs = (block && Array.isArray(block.data)) ? block.data : [];
        for (const tx of txs) {
            if (!tx || String(tx.type).toUpperCase() !== 'CHECKPOINT') continue;
            const snap = normaliseRoot(tx.snapshotRoot);
            const cp = normaliseRoot(tx.checkpointRoot) || normaliseRoot(tx.root);
            const pend = normaliseRoot(tx.pendingRoot);
            if (snap || cp || pend) {
                return {
                    snapshotRoot: snap,
                    checkpointRoot: cp,
                    // The pending-queue commitment. A node restoring its treasury debts
                    // checks a peer-supplied list against THIS before trusting a single row.
                    pendingRoot: pend,
                    epoch: Number(tx.epoch) || 0,
                    height: Number(block.index) || i
                };
            }
        }
    }
    return null;
}

export { PRIORITY };
