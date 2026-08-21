// The LEDGER's handling of RECEIPT and the extended CHECKPOINT envelope.
//   run:  node tests/state-receipt.test.js          (from DataChain_Core/)
//
// state.js opens a pg Pool on import and logs ECONNREFUSED without Postgres. That is
// expected and non-fatal — the class still constructs, and applyTransaction touches no
// database. These tests exercise the in-memory ledger only.
import crypto from 'crypto';
import State from '../state.js';
import { signBatch } from '../receipts.js';

let n = 0; const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };

function verifier() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    return { publicKey, privateKey };
}
const V = [verifier(), verifier(), verifier()];
const RECEIPTS = [
    { address: 'hostA', f: 1e9, q: 1,   u: 1,   home: true },
    { address: 'hostB', f: 5e8, q: 0.9, u: 0.8, home: false }
];
const attest = (vs, epoch = 1, receipts = RECEIPTS) => vs.map(v => ({
    verifier: v.publicKey,
    signature: signBatch({ epoch, receipts, privateKeyPem: v.privateKey })
}));
const receiptTx = (over = {}) => Object.assign({
    from: 'nexus-ai-treasury', to: 'nexus-ai-treasury', amount: 0, type: 'RECEIPT',
    epoch: 1, receipts: RECEIPTS, attestations: attest(V), timestamp: 1
}, over);

const HASH = 'a'.repeat(64);

// ── RECEIPT acceptance ─────────────────────────────────────────────────────────
{
    const st = new State();
    A(st.applyTransaction(receiptTx(), 0, true) === true, 'a properly attested batch is accepted');
    A(st.epochReceipts[1] && st.epochReceipts[1].receipts.length === 2,
        'the batch is recorded against its epoch');
    A(st.epochReceipts[1].verifiers.length === 3, 'the accepted signers are recorded');

    // It must move NO money — the epoch driver pays later, from these numbers.
    A(Object.keys(st.balances.SYR || {}).length === 0, 'a receipt moves no balance');
}

// ── RECEIPT refusal ────────────────────────────────────────────────────────────
{
    const st = new State();
    A(st.applyTransaction(receiptTx({ attestations: attest([V[0]]) }), 0, true) === false,
        'one verifier is not a quorum');
    A(st.applyTransaction(receiptTx({ attestations: attest([V[0], V[0], V[0]]) }), 0, true) === false,
        'one verifier signing three times is still not a quorum');
    A(st.applyTransaction(receiptTx({ attestations: [] }), 0, true) === false,
        'no attestations is refused');

    // Signed for the right epoch, then the numbers edited.
    A(st.applyTransaction(receiptTx({
        receipts: [{ ...RECEIPTS[0], f: 1e15 }, RECEIPTS[1]]
    }), 0, true) === false, 'editing f after signing is refused');

    A(st.applyTransaction(receiptTx({ epoch: 0 }), 0, true) === false, 'epoch 0 is refused');
    A(st.applyTransaction(receiptTx({ receipts: [] }), 0, true) === false, 'an empty batch is refused');
    A(st.applyTransaction(receiptTx({
        receipts: [{ address: 'a', f: 1, q: 9, u: 1, home: false }]
    }), 0, true) === false, 'q out of range is refused');

    A(Object.keys(st.epochReceipts).length === 0, 'nothing refused was recorded');
}

// ── a later batch supersedes an earlier one ────────────────────────────────────
{
    const st = new State();
    st.applyTransaction(receiptTx(), 0, true);
    const corrected = [{ address: 'hostA', f: 7, q: 1, u: 1, home: false }];
    st.applyTransaction(receiptTx({ receipts: corrected, attestations: attest(V, 1, corrected) }), 0, true);
    A(st.epochReceipts[1].receipts.length === 1 && st.epochReceipts[1].receipts[0].f === 7,
        'a corrected batch REPLACES the earlier one rather than adding to it');
}

// ── replay is idempotent ───────────────────────────────────────────────────────
{
    const st = new State();
    const tx = receiptTx();
    st.applyTransaction(tx, 0, true);
    st.applyTransaction(tx, 0, true);
    A(Object.keys(st.epochReceipts).length === 1, 'replaying the same batch twice is a no-op');
    A(st.epochReceipts[1].receipts.length === 2, 'and does not duplicate its rows');
}

// ── the CHECKPOINT envelope ────────────────────────────────────────────────────
{
    const st = new State();
    const cp = (over) => Object.assign({
        from: 't', to: 't', amount: 0, type: 'CHECKPOINT', epoch: 1
    }, over);

    A(st.applyTransaction(cp({ root: HASH }), 0, true) === true, 'a model root alone is valid');
    A(st.applyTransaction(cp({ snapshotRoot: HASH }), 0, true) === true, 'a snapshot root alone is valid');

    // THE REGRESSION: an epoch that carries debts but has no new model checkpoint and no new
    // snapshot emits a commitment with ONLY a pending root. The old rule required `tx.root`
    // specifically and rejected it — a transaction the epoch driver builds and the ledger
    // refuses, which is an instant fork in exactly the case the pending root protects.
    A(st.applyTransaction(cp({ pendingRoot: HASH }), 0, true) === true,
        'a PENDING root alone is valid');

    A(st.applyTransaction(cp({}), 0, true) === false, 'a commitment with no root at all is refused');
    A(st.applyTransaction(cp({ root: 'nope' }), 0, true) === false, 'a malformed root is refused');
    // A half-valid commitment is one nobody can trust.
    A(st.applyTransaction(cp({ root: HASH, pendingRoot: 'nope' }), 0, true) === false,
        'one malformed root spoils an otherwise valid commitment');
}

// ── the ledger lock still guards value transfers ───────────────────────────────
{
    const st = new State();
    A(st.applyTransaction({ from: 'a', to: 'b', amount: 0, type: 'TRANSFER' }, 0, true) === false,
        'the zero-value exemption does NOT leak to TRANSFER');
    A(st.applyTransaction({ from: 'a', to: 'b', amount: -5, type: 'TRANSFER' }, 0, true) === false,
        'negative transfers are still refused');
}

// ── the integrity auditor must see no value in a receipt ───────────────────────
{
    // integrity.deriveBalances replays transactions into balances and is what the ledger
    // audit compares against. A RECEIPT must contribute exactly nothing there — if it ever
    // moved value, the audit would report drift that no transfer explains, which is how the
    // 70,300 SYR phantom-supply hunt started.
    const { deriveBalances, deltaFor } = await import('../integrity.js');
    const tx = receiptTx();
    A(deltaFor(tx, 'hostA', 'SYR') === 0, 'a receipt credits its hosts nothing directly');
    A(deltaFor(tx, 'nexus-ai-treasury', 'SYR') === 0, 'a receipt debits the treasury nothing');

    const derived = deriveBalances([tx]);
    const syr = derived.SYR || {};
    A(Object.values(syr).every(v => v === 0), 'a receipt derives no non-zero balance');
}

console.log(`ALL ${n} STATE-RECEIPT TESTS PASSED`);
