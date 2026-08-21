// Unit tests for on-ledger verified-work receipts (M1).
//   run:  node tests/receipts.test.js          (from DataChain_Core/)
//
// A receipt causes SYR to be paid, so most of these are SECURITY tests, not behaviour
// tests. The three that matter most:
//   · a host cannot pay itself (the quorum is real);
//   · one verifier cannot BE the quorum by signing repeatedly;
//   · a batch cannot be edited after it was signed.
import crypto from 'crypto';
import {
    canonicalPayload, signBatch, verifyAttestations, validateBatch,
    buildReceiptTransaction, receiptsForEpoch,
    pendingRoot, verifyPendingList, RECEIPT_DEFAULTS
} from '../receipts.js';

let n = 0; const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };

// ── helpers ────────────────────────────────────────────────────────────────────
function verifier() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    return { publicKey, privateKey };
}
const V = [verifier(), verifier(), verifier(), verifier()];

const RECEIPTS = [
    { address: 'hostA', f: 1e9, q: 1,   u: 1,   home: true },
    { address: 'hostB', f: 5e8, q: 0.9, u: 0.8, home: false }
];
const attest = (vs, epoch = 1, receipts = RECEIPTS) => vs.map(v => ({
    verifier: v.publicKey,
    signature: signBatch({ epoch, receipts, privateKeyPem: v.privateKey })
}));

// ── canonical payload ──────────────────────────────────────────────────────────
{
    // Every node must reproduce the signed bytes exactly, or a signature verifies on one
    // node and fails on another — which is a fork.
    const a = canonicalPayload({ epoch: 1, receipts: RECEIPTS });
    const b = canonicalPayload({ epoch: 1, receipts: RECEIPTS.slice().reverse() });
    A(a.equals(b), 'receipt ORDER does not change the signed bytes');

    const c = canonicalPayload({ epoch: 2, receipts: RECEIPTS });
    A(!a.equals(c), 'the epoch is part of what is signed');

    const d = canonicalPayload({ epoch: 1, receipts: [{ ...RECEIPTS[0], f: 1e9 + 1 }, RECEIPTS[1]] });
    A(!a.equals(d), 'changing f changes the signed bytes');

    // Fields outside the five consensus ones must not affect the signature, or a producer
    // could attach junk and invalidate a batch other nodes accept.
    const e = canonicalPayload({ epoch: 1, receipts: RECEIPTS.map(r => ({ ...r, note: 'x' })) });
    A(a.equals(e), 'extra fields are not signed');
}

// ── batch structure ────────────────────────────────────────────────────────────
{
    A(validateBatch({ epoch: 1, receipts: RECEIPTS }).ok, 'a well-formed batch validates');

    A(!validateBatch({ epoch: 0, receipts: RECEIPTS }).ok, 'epoch 0 is refused');
    A(!validateBatch({ epoch: -1, receipts: RECEIPTS }).ok, 'a negative epoch is refused');
    A(!validateBatch({ epoch: 1.5, receipts: RECEIPTS }).ok, 'a fractional epoch is refused');
    A(!validateBatch({ epoch: 1, receipts: [] }).ok, 'an empty batch is refused');
    A(!validateBatch({ epoch: 1, receipts: null }).ok, 'a non-array batch is refused');

    // q and u scale a host's share of the pool. A q of 2 would double it, so the bound is
    // load-bearing rather than cosmetic.
    A(!validateBatch({ epoch: 1, receipts: [{ address: 'a', f: 1, q: 2, u: 1, home: false }] }).ok,
        'q above 1 is refused');
    A(!validateBatch({ epoch: 1, receipts: [{ address: 'a', f: 1, q: -0.1, u: 1, home: false }] }).ok,
        'negative q is refused');
    A(!validateBatch({ epoch: 1, receipts: [{ address: 'a', f: 1, q: 1, u: 5, home: false }] }).ok,
        'u above 1 is refused');
    A(!validateBatch({ epoch: 1, receipts: [{ address: 'a', f: -1, q: 1, u: 1, home: false }] }).ok,
        'negative FLOPs are refused');
    A(!validateBatch({ epoch: 1, receipts: [{ address: 'a', f: Infinity, q: 1, u: 1, home: false }] }).ok,
        'infinite FLOPs are refused');
    A(!validateBatch({ epoch: 1, receipts: [{ address: '', f: 1, q: 1, u: 1, home: false }] }).ok,
        'an empty address is refused');

    // Paid twice from one batch would be a straightforward theft.
    A(!validateBatch({ epoch: 1, receipts: [
        { address: 'a', f: 1, q: 1, u: 1, home: false },
        { address: 'a', f: 1, q: 1, u: 1, home: false }
    ] }).ok, 'a duplicate address in one batch is refused');

    A(!validateBatch({ epoch: 1, receipts: [
        { address: 'z', f: 1, q: 1, u: 1, home: false },
        { address: 'a', f: 1, q: 1, u: 1, home: false }
    ] }).ok, 'an unsorted batch is refused (it would hash differently on different nodes)');

    const huge = Array.from({ length: RECEIPT_DEFAULTS.MAX_RECEIPTS + 1 },
        (_, i) => ({ address: 'h' + String(i).padStart(8, '0'), f: 1, q: 1, u: 1, home: false }));
    A(!validateBatch({ epoch: 1, receipts: huge }).ok, 'an oversized batch is refused');
}

// ── THE QUORUM — the security core ─────────────────────────────────────────────
{
    const ok = verifyAttestations({ epoch: 1, receipts: RECEIPTS, attestations: attest(V.slice(0, 3)) });
    A(ok.ok && ok.signers.length === 3, 'three distinct verifiers reach quorum');

    const few = verifyAttestations({ epoch: 1, receipts: RECEIPTS, attestations: attest(V.slice(0, 2)) });
    A(!few.ok && few.reason === 'insufficient-quorum', 'two verifiers do not');
    A(few.required === RECEIPT_DEFAULTS.MIN_VERIFIERS, 'the rejection states what was required');

    // THE ATTACK: one verifier signing three times. Without per-key dedupe this reaches a
    // "quorum" of three on its own and the whole mechanism is decorative.
    const selfQuorum = verifyAttestations({
        epoch: 1, receipts: RECEIPTS,
        attestations: attest([V[0], V[0], V[0]])
    });
    A(!selfQuorum.ok, 'ONE verifier signing three times does NOT reach quorum');
    A(selfQuorum.signers.length === 1, 'repeated signatures from one key count once');

    // THE OTHER ATTACK: a host signs its own receipt. It has one key, so it is the case above.
    const hostSelfSign = verifyAttestations({
        epoch: 1, receipts: RECEIPTS, attestations: attest([V[0]])
    });
    A(!hostSelfSign.ok, 'a host cannot pay itself with its own signature');

    // Tampering after signing.
    const sigs = attest(V.slice(0, 3));
    const tampered = [{ ...RECEIPTS[0], f: 1e15 }, RECEIPTS[1]];
    const edited = verifyAttestations({ epoch: 1, receipts: tampered, attestations: sigs });
    A(!edited.ok, 'inflating f after signing invalidates every signature');

    const wrongEpoch = verifyAttestations({ epoch: 2, receipts: RECEIPTS, attestations: sigs });
    A(!wrongEpoch.ok, 'a batch signed for epoch 1 does not count for epoch 2');

    // Junk must be ignored, not throw and not count.
    const junk = verifyAttestations({
        epoch: 1, receipts: RECEIPTS,
        attestations: [{ verifier: 'not-a-key', signature: 'zz' }, { verifier: null }, null]
            .concat(attest(V.slice(0, 3)))
    });
    A(junk.ok && junk.signers.length === 3, 'malformed attestations are ignored, valid ones still count');

    const tooMany = verifyAttestations({
        epoch: 1, receipts: RECEIPTS,
        attestations: Array.from({ length: RECEIPT_DEFAULTS.MAX_ATTESTATIONS + 1 }, () => ({
            verifier: V[0].publicKey, signature: 'x'
        }))
    });
    A(!tooMany.ok && tooMany.reason === 'too-many-attestations', 'an attestation flood is refused');

    A(verifyAttestations({ epoch: 1, receipts: RECEIPTS, attestations: [] }).ok === false,
        'no attestations is not a quorum');
    A(verifyAttestations({ epoch: 1, receipts: RECEIPTS }).ok === false,
        'missing attestations is not a quorum');
}

// ── the transaction ────────────────────────────────────────────────────────────
{
    const tx = buildReceiptTransaction({
        epoch: 1, receipts: RECEIPTS.slice().reverse(),
        attestations: attest(V.slice(0, 3)), treasuryAddress: 'nexus-ai-treasury'
    });
    A(tx.type === 'RECEIPT', 'the transaction is typed RECEIPT');
    // datachain.js drops any transaction whose amount parses as NaN, so an absent amount
    // would silently delete the whole batch.
    A(tx.amount === 0, 'it carries an explicit zero amount');
    A(tx.receipts[0].address === 'hostA', 'receipts are sorted regardless of input order');
    A(tx.isSystemGenerated === true, 'it is marked system-generated');
    A(buildReceiptTransaction({ epoch: 1, receipts: RECEIPTS, treasuryAddress: null }) === null,
        'no treasury address builds nothing');
}

// ── reading them back off the chain ────────────────────────────────────────────
{
    const mk = (epoch, receipts) => ({ type: 'RECEIPT', epoch, receipts });
    const chain = [
        { index: 0, data: [] },
        { index: 1, data: [mk(1, RECEIPTS)] },
        { index: 2, data: [{ type: 'TRANSFER', from: 'a', to: 'b', amount: 5 }] },
        { index: 3, data: [mk(2, [{ address: 'hostC', f: 1, q: 1, u: 1, home: false }])] }
    ];
    A(receiptsForEpoch(chain, 1).length === 2, 'epoch 1 receipts are found');
    A(receiptsForEpoch(chain, 2)[0].address === 'hostC', 'epoch 2 receipts are found');
    A(receiptsForEpoch(chain, 3).length === 0, 'an epoch with no batch reads empty');
    A(receiptsForEpoch(null, 1).length === 0, 'a missing chain reads empty, it does not throw');
    A(receiptsForEpoch(chain, 0).length === 0, 'epoch 0 reads empty');

    // A correction must SUPERSEDE, not double-count — otherwise a host is paid twice by
    // appending a second batch for the same epoch.
    const corrected = chain.concat([{ index: 4, data: [mk(1, [{ address: 'hostA', f: 1, q: 1, u: 1, home: false }])] }]);
    const got = receiptsForEpoch(corrected, 1);
    A(got.length === 1 && got[0].f === 1, 'the newest batch for an epoch supersedes older ones');
}

// ── the pending queue root ─────────────────────────────────────────────────────
{
    const q = [
        { id: 'e1:hostA', address: 'hostA', amount: 10, priority: 0, since: 1 },
        { id: 'e1:hostB', address: 'hostB', amount: 5,  priority: 0, since: 1 }
    ];
    const root = pendingRoot(q);
    A(typeof root === 'string' && /^[0-9a-f]{64}$/.test(root), 'a queue produces a 32-byte root');
    A(pendingRoot(q.slice().reverse()) === root, 'queue ORDER does not change the root');
    A(pendingRoot([]) === null, 'an empty queue has no root');
    A(pendingRoot(null) === null, 'a missing queue has no root');

    A(verifyPendingList(q, root), 'the real queue verifies against its root');
    A(verifyPendingList([], null), 'an empty queue agrees with a null root');
    A(!verifyPendingList(q, null), 'a non-empty queue does NOT agree with a null root');
    A(!verifyPendingList([], root), 'an empty queue does NOT satisfy a real root');

    // Each of these is a peer quietly editing what the treasury owes.
    A(!verifyPendingList(q.concat([{ id: 'e1:evil', address: 'evil', amount: 1e6, priority: 0, since: 1 }]), root),
        'an ADDED debt is rejected');
    A(!verifyPendingList([q[0]], root), 'a REMOVED debt is rejected');
    A(!verifyPendingList([{ ...q[0], amount: 1e6 }, q[1]], root), 'an INFLATED debt is rejected');
    A(!verifyPendingList([{ ...q[0], address: 'attacker' }, q[1]], root), 'a RE-ADDRESSED debt is rejected');
    A(!verifyPendingList([{ ...q[0], priority: 9 }, q[1]], root), 'a re-PRIORITISED debt is rejected');
}

console.log(`ALL ${n} RECEIPT TESTS PASSED`);
