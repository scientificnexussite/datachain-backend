// ════════════════════════════════════════════════════════════════════════════════
// powpolicy.js — DataChain PoW consensus policy (difficulty hard fork FORK_1). ESM.
// A behaviourally-IDENTICAL CommonJS copy lives at Exe/core/powpolicy.js. Changing ONE
// without the other splits the chain. Full spec: D:\Decisions\Ai\DATACHAIN_DIFFICULTY_FORK.txt
//
// This fork changes ONLY the PoW acceptance test (leading-hex-zeros -> 256-bit numeric
// target) and the retarget (jumpy +/-1 -> smooth clamped), gated at FORK_1_HEIGHT so the
// entire existing chain still validates. Hash preimage, merkleRoot and DB schema are
// UNCHANGED. Pre-fork blocks keep the exact old rule.
// ════════════════════════════════════════════════════════════════════════════════

// ── Fork activation (DORMANT until calibrated) ──────────────────────────────────
// While FORK_1_HEIGHT is this sentinel, every real block index is BELOW it -> the OLD
// leading-hex-zeros rule is used everywhere and behaviour is byte-identical to today.
// Set a REAL future height ONLY after a hashrate measurement + the replay / cross-fork
// tests (spec sec.9), and ship it to BOTH nodes at the same value.
export const FORK_1_HEIGHT = Number.MAX_SAFE_INTEGER;   // TODO(calibrate): real future height

// ── Post-fork parameters (all calibratable, spec sec.11) ────────────────────────
export const TARGET_TIME = 10000;              // ms per block (unchanged)
export const WINDOW      = 30;                 // retarget window (blocks)
export const MAX_STEP    = 4n;                 // target may change at most x4 / /4 per window
export const MIN_D       = 1n << 20n;          // difficulty floor (2^20). TODO(calibrate) to real hashrate
export const SEED_D      = 1n << 20n;          // post-fork starting difficulty. TODO(calibrate)
export const MAX_TARGET  = (1n << 256n) - 1n;  // easiest target (difficulty D = 1)

export function hashToBigInt(hash) { return BigInt('0x' + hash); }
export function targetForD(D)      { D = D < 1n ? 1n : D; return MAX_TARGET / D; }
export function dForTarget(t)      { return t <= 0n ? MAX_TARGET : MAX_TARGET / t; }

// Pre-fork acceptance: N leading hex zeros (identical to the pre-fork code).
export function oldRuleOK(hash, oldDifficulty) {
    const d = Math.max(1, oldDifficulty | 0);
    return hash.startsWith('0'.repeat(d));
}

// One smooth, clamped, integer-only retarget step (fast blocks -> smaller target -> harder).
export function nextTarget(prevTarget, actualMs, expectedMs) {
    let a = BigInt(Math.max(1, Math.round(actualMs)));
    let e = BigInt(Math.max(1, Math.round(expectedMs)));
    if (a > e * MAX_STEP) a = e * MAX_STEP;                 // clamp ratio to <= MAX_STEP
    if (a * MAX_STEP < e) a = (e + MAX_STEP - 1n) / MAX_STEP; // clamp ratio to >= 1/MAX_STEP (ceil)
    let t = (prevTarget * a) / e;
    if (t < 1n) t = 1n;
    const floorCap = MAX_TARGET / MIN_D;                   // difficulty floor <=> target ceiling
    if (t > floorCap) t = floorCap;
    if (t > MAX_TARGET) t = MAX_TARGET;
    return t;
}

// Deterministic post-fork target at height H (pure function of block timestamps + consts).
// `blocks` is the index-ordered chain array up to at least H-1.
export function targetForHeight(blocks, H) {
    let target = targetForD(SEED_D);
    for (let h = FORK_1_HEIGHT + WINDOW; h <= H; h += WINDOW) {
        const endB = blocks[h - 1], startB = blocks[h - 1 - WINDOW];
        if (!endB || !startB) break;
        target = nextTarget(target, endB.timestamp - startB.timestamp, WINDOW * TARGET_TIME);
    }
    return target;
}

// The single height-aware acceptance decision (the consensus gate).
export function isValidPoW(height, hash, blocks, oldDifficulty) {
    if (height < FORK_1_HEIGHT) return oldRuleOK(hash, oldDifficulty);
    return hashToBigInt(hash) <= targetForHeight(blocks, height);
}

// For the miner/worker: the 64-hex target string for a height, or null when pre-fork
// (meaning: mine with the old leading-zeros rule instead).
export function targetHexForHeight(blocks, height) {
    if (height < FORK_1_HEIGHT) return null;
    return targetForHeight(blocks, height).toString(16).padStart(64, '0');
}
