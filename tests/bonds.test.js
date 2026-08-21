// F6 security bonds and the verifier registry.
//   run:  node tests/bonds.test.js          (from DataChain_Core/)
//
// The bond exists for ONE reason: last session's receipt quorum treated "distinct public
// key" as "independent verifier", and keys are free. These tests are mostly about whether
// that hole is actually shut, and whether the money can be gamed on the way in or out.
import {
    BOND_DEFAULTS, validateBond, canRelease, bondsAt, verifierSetAt,
    totalBonded, describeSlash, SLASHING_ENABLED
} from '../bonds.js';

let n = 0; const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };

const KEY = (s) => 'pubkey-' + s + '-'.repeat(40);
const blk = (index, txs) => ({ index, timestamp: 1700000000000 + index, data: txs });
const bond    = (from, amount, key) => ({ type: 'VERIFIER_BOND', from, to: from, amount, verifierKey: key });
const unbond  = (from) => ({ type: 'VERIFIER_UNBOND', from, to: from, amount: 0 });
const release = (from) => ({ type: 'VERIFIER_RELEASE', from, to: from, amount: 0 });

// ── structural validation ──────────────────────────────────────────────────────
{
    A(validateBond({ address: 'nx_a', amount: 100, verifierKey: KEY('a') }).ok,
        'a bond at the minimum is valid');
    A(validateBond({ address: 'nx_a', amount: 1e6, verifierKey: KEY('a') }).ok,
        'a large bond is valid');

    const low = validateBond({ address: 'nx_a', amount: 99, verifierKey: KEY('a') });
    A(!low.ok && low.reason === 'below-minimum', 'below the minimum is refused');
    A(low.required === BOND_DEFAULTS.MIN_BOND, 'and the rejection states the requirement');

    A(!validateBond({ address: 'nx_a', amount: 1e12, verifierKey: KEY('a') }).ok,
        'an absurd bond is refused');
    A(!validateBond({ address: '', amount: 100, verifierKey: KEY('a') }).ok,
        'no address is refused');
    // A bond with no key backs nothing — that is a deposit, not a bond.
    A(!validateBond({ address: 'nx_a', amount: 100 }).ok, 'no verifier key is refused');
    A(!validateBond({ address: 'nx_a', amount: 100, verifierKey: 'short' }).ok,
        'a stub key is refused');
    A(!validateBond({ address: 'nx_a', amount: NaN, verifierKey: KEY('a') }).ok, 'NaN is refused');
    A(!validateBond({ address: 'nx_a', amount: Infinity, verifierKey: KEY('a') }).ok,
        'Infinity is refused');
}

// ── the cooling-off is measured in BLOCKS ──────────────────────────────────────
{
    const b = { amount: 100, releasableAt: 1000 };
    A(!canRelease({ bond: b, height: 999 }).ok, 'one block early is still early');
    A(canRelease({ bond: b, height: 1000 }).ok, 'exactly at the height is allowed');
    A(canRelease({ bond: b, height: 5000 }).ok, 'later is allowed');

    const r = canRelease({ bond: b, height: 500 });
    A(r.reason === 'cooling-off' && r.releasableAt === 1000,
        'the refusal says when it WILL be releasable');

    A(!canRelease({ bond: { amount: 100 }, height: 1e9 }).ok,
        'a bond that never announced an unbond cannot be released');
    A(!canRelease({ bond: null, height: 1 }).ok, 'no bond, no release');
    A(!canRelease({ bond: b, height: NaN }).ok, 'a NaN height is refused, not treated as 0');
}

// ── the registry, derived from the chain ───────────────────────────────────────
{
    const chain = [
        blk(0, []),
        blk(1, [bond('nx_a', 100, KEY('a'))]),
        blk(2, [bond('nx_b', 500, KEY('b'))]),
        blk(3, [bond('nx_c', 50,  KEY('c'))])      // under the minimum
    ];

    const at3 = bondsAt(chain, 3);
    A(Object.keys(at3).length === 3, 'all three bonds are recorded');
    A(at3.nx_b.amount === 500, 'amounts are carried');
    A(totalBonded(at3) === 650, 'the bonded total is the sum');

    const set = verifierSetAt(chain, 3);
    A(set.has(KEY('a')) && set.has(KEY('b')), 'adequately bonded keys are verifiers');
    A(!set.has(KEY('c')), 'an UNDER-bonded key is recorded but is NOT a verifier');
    A(set.size === 2, 'and nobody else is');
}

// ── THE HISTORICAL QUERY — the subtlest requirement ────────────────────────────
{
    // A receipt from epoch 5 is validated whenever the chain is replayed, possibly long
    // after its signers retired. Asking "is K a verifier?" in the PRESENT tense would make
    // their past signatures retroactively invalid and a replay would disagree with the
    // original run — a fork produced by nothing but a badly-phrased question.
    const chain = [
        blk(0, []),
        blk(1, [bond('nx_a', 100, KEY('a'))]),
        blk(2, []),
        blk(3, [unbond('nx_a')]),
        blk(4, [])
    ];

    A(verifierSetAt(chain, 2).has(KEY('a')), 'at height 2 the key WAS a verifier');
    A(!verifierSetAt(chain, 4).has(KEY('a')), 'at height 4, after unbonding, it is not');
    A(verifierSetAt(chain, 2).has(KEY('a')),
        'asking about height 2 again STILL says yes — history does not change');

    A(!bondsAt(chain, 1).nx_a.releasableAt, 'at height 1 there is no pending release');
    A(bondsAt(chain, 4).nx_a.releasableAt === 3 + BOND_DEFAULTS.COOLING_OFF_BLOCKS,
        'the cooling-off is counted from the unbond height');
    // The money is still at risk even though the key has stopped counting.
    A(bondsAt(chain, 4).nx_a.amount === 100, 'unbonding does not return the funds');
}

// ── unbonding is not an escape hatch ───────────────────────────────────────────
{
    const chain = [
        blk(0, []),
        blk(1, [bond('nx_a', 100, KEY('a'))]),
        blk(2, [unbond('nx_a')])
    ];
    A(!verifierSetAt(chain, 2).has(KEY('a')),
        'a key stops counting the moment it announces an unbond');
    A(totalBonded(bondsAt(chain, 2)) === 100,
        'but its money stays bonded through the cooling-off — quitting must not escape a judgement');
}

// ── topping up must not leave a gap ────────────────────────────────────────────
{
    const chain = [
        blk(0, []),
        blk(1, [bond('nx_a', 100, KEY('a'))]),
        blk(2, [bond('nx_a', 400, KEY('a'))])
    ];
    A(bondsAt(chain, 2).nx_a.amount === 500, 'a second bond TOPS UP rather than replacing');
    A(bondsAt(chain, 2).nx_a.since === 1, 'the original bonding height is kept');
    A(verifierSetAt(chain, 2).has(KEY('a')), 'and the key is continuously a verifier');

    // Topping up should also cancel a withdrawal in progress — otherwise a verifier that
    // changed its mind would have to wait out a cooling-off it no longer wants.
    const changed = [
        blk(0, []), blk(1, [bond('nx_a', 100, KEY('a'))]),
        blk(2, [unbond('nx_a')]), blk(3, [bond('nx_a', 100, KEY('a'))])
    ];
    A(!bondsAt(changed, 3).nx_a.releasableAt, 're-bonding cancels a pending unbond');
    A(verifierSetAt(changed, 3).has(KEY('a')), 'and the key counts again');
}

// ── release removes the bond entirely ──────────────────────────────────────────
{
    const chain = [
        blk(0, []), blk(1, [bond('nx_a', 100, KEY('a'))]),
        blk(2, [unbond('nx_a')]), blk(3, [release('nx_a')])
    ];
    A(!bondsAt(chain, 3).nx_a, 'a released bond leaves the registry');
    A(totalBonded(bondsAt(chain, 3)) === 0, 'and the bonded total returns to zero');
    A(bondsAt(chain, 2).nx_a.amount === 100, 'while history before the release is unchanged');
}

// ── slashing is defined but NOT armed ──────────────────────────────────────────
{
    A(SLASHING_ENABLED === false, 'slashing ships DISABLED');
    const d = describeSlash({ bond: { amount: 100 } });
    A(d.enabled === false, 'the description says so');
    A(d.burn === 100, 'a full slash would BURN the whole bond (F6: burned 100%, not paid out)');
    A(describeSlash({ bond: { amount: 100 }, fraction: 0.5 }).burn === 50, 'a partial slash burns its fraction');
    A(describeSlash({ bond: { amount: 100 }, fraction: 5 }).burn === 100, 'a fraction above 1 is clamped');
    A(describeSlash({ bond: null }).burn === 0, 'no bond, nothing to burn');
}

// ── junk must not throw ────────────────────────────────────────────────────────
{
    A(Object.keys(bondsAt(null, 5)).length === 0, 'a missing chain yields an empty registry');
    A(verifierSetAt(null, 5).size === 0, 'and an empty verifier set');
    A(totalBonded(null) === 0, 'a missing registry totals zero');
    A(Object.keys(bondsAt([blk(0, 'not an array')], 5)).length === 0,
        'a block whose data is a string is skipped');
    A(Object.keys(bondsAt([blk(0, [null, {}, { type: 'VERIFIER_BOND' }])], 5)).length === 0,
        'malformed transactions are ignored');
}

console.log(`ALL ${n} BOND TESTS PASSED`);
