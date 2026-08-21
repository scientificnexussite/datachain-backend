// The LEDGER's handling of F6 bonds, and the sybil gate they enable.
//   run:  node tests/state-bond.test.js          (from DataChain_Core/)
//
// state.js opens a pg Pool at import and logs ECONNREFUSED without Postgres. Expected and
// non-fatal — applyTransaction touches no database.
import crypto from 'crypto';
import State from '../state.js';
import { BOND_DEFAULTS, verifierSetAt } from '../bonds.js';
import { signBatch, verifyAttestations } from '../receipts.js';

let n = 0; const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };

function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    return { publicKey, privateKey };
}

const mint = (to, amount) => ({ type: 'MINT', from: 'system', to, amount, tokenSymbol: 'SYR' });
const bond = (from, amount, key, height = 0) =>
    ({ type: 'VERIFIER_BOND', from, to: from, amount, tokenSymbol: 'SYR', verifierKey: key, height });
const unbond  = (from, height = 0) => ({ type: 'VERIFIER_UNBOND', from, to: from, amount: 0, tokenSymbol: 'SYR', height });
const release = (from, height = 0) => ({ type: 'VERIFIER_RELEASE', from, to: from, amount: 0, tokenSymbol: 'SYR', height });

// ── bonding moves real money ───────────────────────────────────────────────────
{
    const st = new State();
    const K = keypair().publicKey;
    st.applyTransaction(mint('nx_a', 1000), 0, true);
    A(st.getBalance('nx_a', 'SYR') === 1000, 'opening balance');

    A(st.applyTransaction(bond('nx_a', 400, K, 10), 0, true) === true, 'a funded bond is accepted');
    // THE CORE PROPERTY: the money leaves the spendable balance entirely, so every
    // "what can this address spend" path is correct without being changed.
    A(st.getBalance('nx_a', 'SYR') === 600, 'the bond is DEBITED from the spendable balance');
    A(st.bonds.nx_a.amount === 400, 'and held in the bond record');
    A(st.bonds.nx_a.verifierKey === K, 'with the key it backs');
}

// ── a bonded balance cannot be spent ───────────────────────────────────────────
{
    const st = new State();
    const K = keypair().publicKey;
    st.applyTransaction(mint('nx_a', 1000), 0, true);
    st.applyTransaction(bond('nx_a', 900, K, 10), 0, true);

    // 100 spendable, 900 bonded. A transfer of 500 must fail — it would be spending the bond.
    const spend = { type: 'TRANSFER', from: 'nx_a', to: 'nx_b', amount: 500, tokenSymbol: 'SYR' };
    A(st.applyTransaction(spend, 0, false) === false, 'a bonded balance CANNOT be transferred');
    A(st.getBalance('nx_b', 'SYR') === 0, 'and the recipient got nothing');

    const ok = { type: 'TRANSFER', from: 'nx_a', to: 'nx_b', amount: 100, tokenSymbol: 'SYR' };
    A(st.applyTransaction(ok, 0, false) === true, 'the unbonded remainder is still spendable');

    // Nor can it be bonded twice.
    A(st.applyTransaction(bond('nx_a', 900, K, 11), 0, false) === false,
        'the same money cannot be bonded a second time');
}

// ── overdrawing a bond is refused by the ordinary guard ────────────────────────
{
    const st = new State();
    const K = keypair().publicKey;
    st.applyTransaction(mint('nx_a', 100), 0, true);
    A(st.applyTransaction(bond('nx_a', 5000, K, 1), 0, false) === false, 'a bond you cannot afford is refused');
    A(st.getBalance('nx_a', 'SYR') === 100, 'and nothing was debited');
    A(!st.bonds.nx_a, 'and no bond was recorded');

    A(st.applyTransaction(bond('nx_a', 50, K, 1), 0, false) === false,
        'a bond below the F6 minimum is refused');
    A(st.applyTransaction({ ...bond('nx_a', 100, K, 1), verifierKey: undefined }, 0, false) === false,
        'a bond backing no key is refused');
}

// ── the cooling-off is enforced ────────────────────────────────────────────────
{
    const st = new State();
    const K = keypair().publicKey;
    st.applyTransaction(mint('nx_a', 1000), 0, true);
    st.applyTransaction(bond('nx_a', 500, K, 10), 0, true);

    A(st.applyTransaction(release('nx_a', 20), 0, false) === false,
        'releasing without unbonding first is refused');

    A(st.applyTransaction(unbond('nx_a', 100), 0, true) === true, 'unbond is accepted');
    A(st.getBalance('nx_a', 'SYR') === 500, 'unbonding does NOT return the money');
    A(st.bonds.nx_a.releasableAt === 100 + BOND_DEFAULTS.COOLING_OFF_BLOCKS,
        'the release height is set from the unbond height');

    A(st.applyTransaction(release('nx_a', 200), 0, false) === false,
        'releasing during the cooling-off is refused — otherwise the deterrent is theatre');
    A(st.getBalance('nx_a', 'SYR') === 500, 'and nothing was returned');

    const after = 100 + BOND_DEFAULTS.COOLING_OFF_BLOCKS;
    A(st.applyTransaction(release('nx_a', after), 0, true) === true, 'release after the delay is allowed');
    A(st.getBalance('nx_a', 'SYR') === 1000, 'the exact bonded amount comes back');
    A(!st.bonds.nx_a, 'and the bond is gone');
}

// ── conservation: bonding destroys nothing ─────────────────────────────────────
{
    const st = new State();
    const K = keypair().publicKey;
    st.applyTransaction(mint('nx_a', 1000), 0, true);
    st.applyTransaction(bond('nx_a', 700, K, 1), 0, true);
    const spendable = st.getBalance('nx_a', 'SYR');
    const bonded = st.bonds.nx_a.amount;
    A(spendable + bonded === 1000,
        'spendable + bonded equals what was minted — bonding must not burn or mint');
}

// ── THE SYBIL GATE — the reason bonds exist ────────────────────────────────────
{
    const st = new State();
    const RECEIPTS = [{ address: 'hostA', f: 1e9, q: 1, u: 1, home: true }];

    // Four keypairs. Only THREE are bonded; the fourth is a free-to-mint impostor.
    const bonded = [keypair(), keypair(), keypair()];
    const impostor = keypair();

    const chain = [{ index: 1, data: bonded.map((v, i) =>
        bond('nx_v' + i, 100, v.publicKey, 1)) }];
    const set = verifierSetAt(chain, 1);
    A(set.size === 3, 'three bonded verifiers are registered');

    const sign = (vs) => vs.map(v => ({
        verifier: v.publicKey,
        signature: signBatch({ epoch: 1, receipts: RECEIPTS, privateKeyPem: v.privateKey })
    }));

    // Genuine quorum.
    const good = verifyAttestations({ epoch: 1, receipts: RECEIPTS, attestations: sign(bonded), verifierSet: set });
    A(good.ok, 'three bonded verifiers reach quorum');
    A(good.gated === true, 'and the bond gate was actually applied');

    // THE ATTACK THE BOND EXISTS TO STOP: minting keys to manufacture independence.
    const sybils = [keypair(), keypair(), keypair()];
    const attack = verifyAttestations({ epoch: 1, receipts: RECEIPTS, attestations: sign(sybils), verifierSet: set });
    A(!attack.ok, 'THREE FREELY-MINTED KEYS DO NOT REACH QUORUM — this is the whole point');
    A(attack.reason === 'signers-not-bonded', 'and the reason names the actual problem');
    A(attack.signers.length === 0, 'none of them counted');

    // A real verifier padded out with impostors gets no help from them.
    const padded = verifyAttestations({
        epoch: 1, receipts: RECEIPTS,
        attestations: sign([bonded[0], impostor, impostor]), verifierSet: set
    });
    A(!padded.ok, 'one real verifier plus impostors is still not a quorum');
    A(padded.signers.length === 1, 'only the bonded signer counted');

    // Without a set supplied, the old weaker behaviour — documented, not accidental.
    const ungated = verifyAttestations({ epoch: 1, receipts: RECEIPTS, attestations: sign(sybils) });
    A(ungated.ok && ungated.gated === false,
        'with no registry the check degrades to distinct-keys, and says so');
}

// ── an under-bonded verifier does not count ────────────────────────────────────
{
    const poor = keypair(), rich1 = keypair(), rich2 = keypair(), rich3 = keypair();
    const chain = [{ index: 1, data: [
        bond('nx_poor', 50, poor.publicKey, 1),        // below MIN_BOND
        bond('nx_r1', 100, rich1.publicKey, 1),
        bond('nx_r2', 100, rich2.publicKey, 1),
        bond('nx_r3', 100, rich3.publicKey, 1)
    ] }];
    const set = verifierSetAt(chain, 1);
    A(!set.has(poor.publicKey), 'an under-bonded key is not in the verifier set');
    A(set.size === 3, 'the adequately bonded ones are');
}

console.log(`ALL ${n} STATE-BOND TESTS PASSED`);
