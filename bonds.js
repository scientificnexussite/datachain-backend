// ════════════════════════════════════════════════════════════════════════════════
// bonds.js — the F6 security bond and the verifier registry it backs
//
// WHAT THIS IS FOR. Last session's receipt quorum requires several *independent*
// verifiers to sign a batch before it can pay anyone — but "independent" meant only
// "distinct public keys", and keys cost nothing to mint. One person with four keypairs
// was a quorum. This is the missing leg.
//
//     19_THREAT_MODEL:43  sybil/collusion -> per-identity caps (F12) + STAKE + randomized
//                         assignment (F14).  Caps exist. Assignment exists. Stake did not.
//     FORMULAS F6         "each host posts stake S, slashed on detected fraud. Rational
//                          hosts stay honest when  E[gain] < p_detect * S"
//     FORMULAS F12        "the CAP + stake/personhood is the real backstop" — because the
//                          home-vs-datacenter weight h_i is spoofable.
//
// ── ⚠️ THIS IS NOT `/stake/lock` ────────────────────────────────────────────────
// api.js:5059 already has something called staking. It is a YIELD PRODUCT: deposit SYR
// for 7/30/90 days and earn a return. It emits a plain TRANSFER to 'staking_pool' and
// records the lock in a POSTGRES table (staking_positions), so the chain sees only an
// ordinary transfer and a replaying node cannot tell the funds were ever locked.
//
// This is a SECURITY BOND: money at risk that makes cheating negative-EV. Different
// purpose, different lifetime, different minimum, and only this one may ever be slashed.
// They use different transaction types on purpose — nobody should have to work out which
// "stake" a transaction meant.
//
// ── HOW UNSPENDABILITY IS ACHIEVED ──────────────────────────────────────────────
// A bond DEBITS the spendable balance and records the amount here. It does not set a flag
// on a balance that transfers must remember to check. That matters: every "what can this
// address spend" path — getBalance, the transfer guard, the exe's own balance reads — is
// then correct with no changes at all, because the money is simply not in the balance map.
// A lock that relies on every future spend path remembering to subtract it is a lock that
// will eventually be forgotten.
//
// ⚠️ SUPPLY ACCOUNTING: bonded SYR leaves the balances map but is NOT destroyed. Anything
// that totals supply must add `totalBonded()` back, or bonding will look like a burn.
// ════════════════════════════════════════════════════════════════════════════════

export const BOND_DEFAULTS = {
    // S, from 05_TOKENOMICS §7: "Stake S (F6, denominated in SYR ~50-100)".
    //
    // ⚠️ PROVISIONAL. F6 is explicit that the real value needs live data:
    // "Still open: real values for S and p_detect (need live data)." Use
    // verify.stakeIsSufficient() to check a bond against an actual expected gain rather
    // than treating this floor as a proof of anything.
    //
    // Deliberately the same number as serving.js MIN_STAKE — one bond, one meaning.
    MIN_BOND: 100,

    // How long a bond stays at risk after the verifier stops verifying, in BLOCKS.
    //
    // BLOCKS, NOT WALL-CLOCK, for two reasons: every node must agree on whether the delay
    // has elapsed (Date.now() differs per machine and would fork), and block height is the
    // only clock the chain actually has. 8640 blocks is one day at the 10s target, matching
    // EPOCH_BLOCKS so a bond survives at least one full settlement it might be judged on.
    COOLING_OFF_BLOCKS: 8640,

    // A bond far larger than needed is fine, but an absurd one is a sign of a malformed
    // transaction rather than a serious verifier.
    MAX_BOND: 1e9
};

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Is this a well-formed bond transaction?
 * Structural only — whether the address can AFFORD it is the ledger's business, checked
 * through the same overdraft path as any transfer.
 */
export function validateBond({ address, amount, verifierKey, params = {} } = {}) {
    const p = Object.assign({}, BOND_DEFAULTS, params);

    if (typeof address !== 'string' || !address) return { ok: false, reason: 'bad-address' };
    if (!isNum(amount) || amount < p.MIN_BOND) {
        return { ok: false, reason: 'below-minimum', required: p.MIN_BOND };
    }
    if (amount > p.MAX_BOND) return { ok: false, reason: 'above-maximum' };

    // The key is what signs receipts; the address is what pays for it. A bond with no key
    // backs nothing, which is a deposit, not a bond.
    if (typeof verifierKey !== 'string' || verifierKey.length < 32) {
        return { ok: false, reason: 'bad-verifier-key' };
    }
    return { ok: true, reason: null };
}

/** Has a released bond served its cooling-off? Heights, never timestamps. */
export function canRelease({ bond, height } = {}) {
    if (!bond) return { ok: false, reason: 'no-bond' };
    if (!bond.releasableAt) return { ok: false, reason: 'not-unbonding' };
    const h = Number(height);
    if (!Number.isFinite(h)) return { ok: false, reason: 'bad-height' };
    if (h < bond.releasableAt) {
        return { ok: false, reason: 'cooling-off', releasableAt: bond.releasableAt, height: h };
    }
    return { ok: true, reason: null };
}

/**
 * Replay the chain up to `height` and return the bond registry as it stood THEN.
 *
 * ⚠️ HISTORICAL BY DESIGN, and this is the subtlest requirement in the whole feature.
 * A receipt from epoch 5 is validated whenever the chain is replayed — possibly months
 * later, long after the verifiers who signed it retired. Checking such a batch against
 * TODAY's registry would make their past signatures retroactively invalid, so a replay
 * would reach a different answer than the original run did. That is a fork with no
 * attacker involved, produced purely by asking the question in the present tense.
 *
 * Cost is O(chain). Acceptable because it is asked once per epoch, not per transaction;
 * if that changes, cache by height rather than making the query current-only.
 *
 * @returns {Object} address -> { amount, verifierKey, since, releasableAt }
 */
export function bondsAt(chain, height) {
    const out = {};
    if (!Array.isArray(chain)) return out;
    const upTo = Number.isFinite(Number(height)) ? Number(height) : Infinity;

    for (const block of chain) {
        const idx = Number(block && block.index);
        if (Number.isFinite(idx) && idx > upTo) break;          // blocks are ordered
        const txs = (block && Array.isArray(block.data)) ? block.data : [];

        for (const tx of txs) {
            if (!tx) continue;
            const type = String(tx.type).toUpperCase();
            const addr = tx.from;
            if (!addr) continue;

            if (type === 'VERIFIER_BOND') {
                // Re-bonding TOPS UP rather than replacing, so a verifier can strengthen its
                // position without a withdraw/re-deposit round trip that would leave it
                // unbonded in between.
                const prev = out[addr];
                out[addr] = {
                    amount: (prev ? prev.amount : 0) + (Number(tx.amount) || 0),
                    verifierKey: typeof tx.verifierKey === 'string' ? tx.verifierKey
                                                                    : (prev ? prev.verifierKey : null),
                    since: prev ? prev.since : idx,
                    releasableAt: null      // topping up cancels any pending unbond
                };
            } else if (type === 'VERIFIER_UNBOND') {
                const prev = out[addr];
                if (!prev) continue;
                // De-registers IMMEDIATELY (see verifierSetAt) but the money stays at risk
                // until the cooling-off elapses. Quitting must not be an escape hatch.
                out[addr] = Object.assign({}, prev, {
                    releasableAt: idx + BOND_DEFAULTS.COOLING_OFF_BLOCKS
                });
            } else if (type === 'VERIFIER_RELEASE') {
                delete out[addr];
            }
        }
    }
    return out;
}

/**
 * The keys that counted as bonded verifiers at a given block height.
 *
 * A key counts only while its bond is BOTH adequate and not being withdrawn: an address
 * that has announced an unbond stops signing at once, even though its money is still at
 * risk for another cooling-off period. Those two facts are deliberately not the same.
 */
export function verifierSetAt(chain, height, params = {}) {
    const p = Object.assign({}, BOND_DEFAULTS, params);
    const bonds = bondsAt(chain, height);
    const set = new Set();
    for (const addr of Object.keys(bonds)) {
        const b = bonds[addr];
        if (!b || !b.verifierKey) continue;
        if (b.releasableAt) continue;             // unbonding: no longer a verifier
        if (!(b.amount >= p.MIN_BOND)) continue;
        set.add(b.verifierKey);
    }
    return set;
}

/** Total SYR held in bonds — add this back wherever circulating supply is totalled. */
export function totalBonded(bonds) {
    if (!bonds || typeof bonds !== 'object') return 0;
    return Object.values(bonds).reduce((s, b) => s + (Number(b && b.amount) || 0), 0);
}

// ── SLASHING — DEFINED, DELIBERATELY NOT ARMED ─────────────────────────────────
//
// F6 says a detected cheat loses its bond, and 05_TOKENOMICS:135 says slashed SYR BURNS
// 100% rather than being paid to anyone. That is written down here so the shape is fixed,
// and left switched off because:
//
//   · it destroys real user funds on an automated judgement, and
//   · the honesty signal q that would trigger it has only ever been fed by test fixtures,
//     never by a live host. F6 itself lists p_detect as an open parameter.
//
// Arming this needs live data first. Until then a slash is an owner decision, taken with a
// human looking at it — not a rule the chain applies on its own.
export const SLASHING_ENABLED = false;

/**
 * What a slash WOULD do. Returns a description; applies nothing.
 * Kept as a pure function so the accounting can be reviewed and tested long before any
 * code path is allowed to call it for real.
 */
export function describeSlash({ bond, fraction = 1 } = {}) {
    const amount = Math.max(0, Number(bond && bond.amount) || 0);
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    return {
        enabled: SLASHING_ENABLED,
        burn: amount * f,          // BURNED, not transferred — nobody is paid for catching it
        remaining: amount * (1 - f),
        note: SLASHING_ENABLED ? 'armed' : 'slashing is disabled; this is a description only'
    };
}
