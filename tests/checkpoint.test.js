/* ════════════════════════════════════════════════════════════════════════════════
   checkpoint.test.js — F15 erasure-coded checkpoints, Merkle commitment, storage proofs.

   The property that matters is BLUNT: after losing any n-k chunks, do the ORIGINAL BYTES
   come back exactly? Model weights cannot be regenerated, so "close" is worthless. These
   tests therefore check exact byte equality after every survivable loss pattern, not just
   that decode returns something.
   ════════════════════════════════════════════════════════════════════════════════ */
import {
    encodeCheckpoint, decodeCheckpoint, merkleRoot, merkleProof, verifyChunk,
    makeChallenge, answerChallenge, verifyStorageProof,
    recoveryProbability, chooseN, CHECKPOINT_DEFAULTS
} from '../checkpoint.js';
import crypto from 'crypto';

let n = 0;
const A = (c, m) => { n++; if (!c) { console.error('FAIL:', m); process.exit(1); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── round trip with every chunk present ───────────────────────────────────────
{
    const data = crypto.randomBytes(5000);
    const enc = encodeCheckpoint(data, { k: 10, n: 16 });
    A(enc.chunks.length === 16, 'n chunks are produced');
    A(enc.originalLength === 5000, 'the original length is carried for exact trimming');
    A(enc.chunks.every(c => c.data.length === enc.shardLength), 'all chunks are the same size');

    const back = decodeCheckpoint(enc.chunks, enc);
    A(Buffer.compare(Buffer.from(back), data) === 0, 'a full chunk set rebuilds the checkpoint EXACTLY');

    // Systematic code: the first k chunks ARE the data, so an intact checkpoint is free to read.
    const direct = Buffer.concat(enc.chunks.slice(0, 10).map(c => c.data)).subarray(0, 5000);
    A(Buffer.compare(direct, data) === 0, 'the first k chunks are the original data (systematic encoding)');
}

// ── ANY k chunks must reconstruct — this is the whole promise ─────────────────
{
    const data = crypto.randomBytes(3333);
    const enc = encodeCheckpoint(data, { k: 4, n: 8 });

    // Every possible 4-of-8 combination, not a sample. 70 combinations is cheap, and a
    // code that works for "most" chunk sets is not an erasure code.
    let tested = 0;
    for (let a = 0; a < 8; a++)
        for (let b = a + 1; b < 8; b++)
            for (let c = b + 1; c < 8; c++)
                for (let d = c + 1; d < 8; d++) {
                    const subset = [a, b, c, d].map(i => enc.chunks[i]);
                    const back = decodeCheckpoint(subset, enc);
                    if (Buffer.compare(Buffer.from(back), data) !== 0) {
                        console.error('FAIL: subset', a, b, c, d, 'did not reconstruct');
                        process.exit(1);
                    }
                    tested++;
                }
    A(tested === 70, 'all 70 possible 4-of-8 chunk combinations were tested');
    A(true, 'EVERY k-subset reconstructs the checkpoint exactly (the MDS property)');
}

// ── losing the data chunks (worst realistic case) ─────────────────────────────
{
    const data = crypto.randomBytes(2048);
    const enc = encodeCheckpoint(data, { k: 10, n: 16 });
    // Lose 6 of the 10 systematic chunks: recovery now depends entirely on parity.
    const survivors = enc.chunks.filter(c => c.index >= 6);
    A(survivors.length === 10, 'exactly k chunks survive');
    const back = decodeCheckpoint(survivors, enc);
    A(Buffer.compare(Buffer.from(back), data) === 0,
      'the checkpoint survives losing 6 of the 10 DATA chunks, rebuilt from parity');
}
{
    const data = crypto.randomBytes(1000);
    const enc = encodeCheckpoint(data, { k: 3, n: 6 });
    // Only parity chunks left.
    const back = decodeCheckpoint(enc.chunks.slice(3), enc);
    A(Buffer.compare(Buffer.from(back), data) === 0, 'parity chunks alone rebuild the checkpoint');
}

// ── too few chunks must FAIL LOUDLY, never return partial data ────────────────
{
    const data = crypto.randomBytes(900);
    const enc = encodeCheckpoint(data, { k: 5, n: 9 });
    let threw = false;
    try { decodeCheckpoint(enc.chunks.slice(0, 4), enc); } catch (e) { threw = true; }
    A(threw, 'fewer than k chunks throws rather than returning corrupt data');

    // A duplicate must not count as two distinct chunks.
    threw = false;
    try {
        decodeCheckpoint([enc.chunks[0], enc.chunks[0], enc.chunks[1], enc.chunks[2], enc.chunks[3]], enc);
    } catch (e) { threw = true; }
    A(threw, 'a duplicated chunk does not satisfy the k-chunk requirement');
}

// ── sizes and edge cases ──────────────────────────────────────────────────────
{
    for (const size of [1, 7, 63, 64, 65, 1023, 4096]) {
        const data = crypto.randomBytes(size);
        const enc = encodeCheckpoint(data, { k: 4, n: 7 });
        const back = decodeCheckpoint(enc.chunks.slice(2), enc);
        A(Buffer.compare(Buffer.from(back), data) === 0, `a ${size}-byte checkpoint round-trips exactly`);
    }
    // Padding must be trimmed, or the rebuilt checkpoint hashes differently.
    const odd = crypto.randomBytes(101);
    const enc = encodeCheckpoint(odd, { k: 10, n: 14 });
    const back = decodeCheckpoint(enc.chunks.slice(0, 10), enc);
    A(Buffer.from(back).length === 101, 'padding is trimmed back to the original length');
}
{
    let threw = false;
    try { encodeCheckpoint(Buffer.alloc(0), { k: 3, n: 6 }); } catch (e) { threw = true; }
    A(threw, 'an empty checkpoint is refused');
    threw = false;
    try { encodeCheckpoint(Buffer.from('x'), { k: 6, n: 3 }); } catch (e) { threw = true; }
    A(threw, 'n must exceed k');
    threw = false;
    try { encodeCheckpoint(Buffer.from('x'), { k: 200, n: 300 }); } catch (e) { threw = true; }
    A(threw, 'more than 255 chunks is refused (GF(256) limit)');
}

// ── Merkle commitment ─────────────────────────────────────────────────────────
{
    const data = crypto.randomBytes(2000);
    const enc = encodeCheckpoint(data, { k: 6, n: 10 });
    const root = merkleRoot(enc.chunks);
    A(/^[0-9a-f]{64}$/.test(root), 'the checkpoint commits to a 32-byte root');
    A(merkleRoot(enc.chunks.slice().reverse()) === root, 'the root is independent of chunk order');

    for (const c of enc.chunks) {
        const proof = merkleProof(enc.chunks, c.index);
        A(verifyChunk({ index: c.index, data: c.data, proof, root }),
          `chunk ${c.index} verifies against the on-chain root`);
    }

    // Tampering must be caught — that is the point of committing the root.
    const bad = Buffer.from(enc.chunks[0].data);
    bad[0] ^= 0xff;
    A(!verifyChunk({ index: 0, data: bad, proof: merkleProof(enc.chunks, 0), root }),
      'a TAMPERED chunk fails verification');
    A(!verifyChunk({ index: 1, data: enc.chunks[0].data, proof: merkleProof(enc.chunks, 1), root }),
      'a chunk presented under the wrong index fails verification');
    A(!verifyChunk({ index: 0, data: enc.chunks[0].data, proof: merkleProof(enc.chunks, 0), root: 'ab'.repeat(32) }),
      'a chunk does not verify against the wrong root');

    const changed = encodeCheckpoint(crypto.randomBytes(2000), { k: 6, n: 10 });
    A(merkleRoot(changed.chunks) !== root, 'a different checkpoint commits to a different root');
    A(merkleRoot([]) === null, 'no chunks means no root');
    A(merkleProof(enc.chunks, 999) === null, 'a proof for a nonexistent chunk is refused');
}
{
    // Odd node counts must not collapse two chunk sets onto the same root.
    const a = encodeCheckpoint(crypto.randomBytes(500), { k: 2, n: 5 });
    const b = encodeCheckpoint(crypto.randomBytes(500), { k: 2, n: 5 });
    A(merkleRoot(a.chunks) !== merkleRoot(b.chunks), 'odd chunk counts still produce distinct roots');
    for (const c of a.chunks) {
        A(verifyChunk({ index: c.index, data: c.data, proof: merkleProof(a.chunks, c.index), root: merkleRoot(a.chunks) }),
          `odd-tree chunk ${c.index} still verifies`);
    }
}

// ── proof of retrievability ───────────────────────────────────────────────────
{
    const data = crypto.randomBytes(1500);
    const enc = encodeCheckpoint(data, { k: 5, n: 8 });
    const root = merkleRoot(enc.chunks);
    const chunk = enc.chunks[3];
    const proof = merkleProof(enc.chunks, 3);

    const nonce = makeChallenge();
    A(/^[0-9a-f]{64}$/.test(nonce), 'a challenge nonce is 32 bytes of hex');
    A(makeChallenge() !== makeChallenge(), 'challenges are not repeated');

    const answer = answerChallenge(nonce, chunk.data);
    A(verifyStorageProof({ nonce, index: 3, data: chunk.data, answer, proof, root }),
      'a host holding the chunk passes the challenge');

    // Replay: an answer to an OLD nonce must not satisfy a NEW challenge, or a host could
    // record one proof and be paid forever for data it has since deleted.
    A(!verifyStorageProof({ nonce: makeChallenge(), index: 3, data: chunk.data, answer, proof, root }),
      'an answer cannot be replayed against a different challenge');

    // Holding the right bytes but not the committed ones, or vice versa, both fail.
    const fake = crypto.randomBytes(chunk.data.length);
    A(!verifyStorageProof({ nonce, index: 3, data: fake, answer: answerChallenge(nonce, fake), proof, root }),
      'answering with data that is not the committed chunk fails');
    A(!verifyStorageProof({ nonce, index: 3, data: chunk.data, answer: 'deadbeef', proof, root }),
      'a wrong answer fails even with a valid Merkle proof');
    A(!verifyStorageProof({ nonce, index: 3, data: chunk.data, answer, proof: merkleProof(enc.chunks, 4), root }),
      'a valid answer with the WRONG proof fails');
    A(!verifyStorageProof({ index: 3, data: chunk.data, answer, proof, root }),
      'a missing nonce fails');
}

// ── sizing from real churn ────────────────────────────────────────────────────
{
    A(near(recoveryProbability(1, 10, 16), 1), 'perfectly available chunks always recover');
    A(recoveryProbability(0, 10, 16) === 0, 'no availability means no recovery');
    A(recoveryProbability(0.9, 10, 16) > recoveryProbability(0.9, 10, 12),
      'more parity raises durability');
    A(recoveryProbability(0.95, 10, 16) > recoveryProbability(0.80, 10, 16),
      'more reliable hosts raise durability');
    A(near(recoveryProbability(0.5, 1, 1), 0.5), 'the 1-of-1 case is just chunk availability');
    A(Number.isNaN(recoveryProbability(1.5, 10, 16)), 'an out-of-range availability is rejected');
    A(recoveryProbability(0.9, 10, 200) >= 0, 'large n does not overflow the binomial');

    const n16 = chooseN(0.9, 10, 1 - 1e-6);
    A(n16 !== null && recoveryProbability(0.9, 10, n16) >= 1 - 1e-6,
      'chooseN returns an n that actually meets the durability target');
    A(chooseN(0.9, 10, 1 - 1e-6) <= chooseN(0.7, 10, 1 - 1e-6),
      'flakier hosts require more chunks');
    A(chooseN(0.99, 10, 1 - 1e-6) < 20, 'reliable hosts need modest overhead');

    // The shipped default must actually be defensible, not a guess.
    const p = recoveryProbability(0.9, CHECKPOINT_DEFAULTS.K, CHECKPOINT_DEFAULTS.N);
    A(p > 0.999, `the default ${CHECKPOINT_DEFAULTS.K}-of-${CHECKPOINT_DEFAULTS.N} survives 10% churn (P=${p.toFixed(6)})`);
}

// ── end to end: encode -> commit -> lose chunks -> prove -> rebuild ───────────
{
    const model = crypto.randomBytes(8192);
    const enc = encodeCheckpoint(model, { k: 10, n: 16 });
    const root = merkleRoot(enc.chunks);

    // Six hosts leave. The remaining ten prove they still hold their chunks.
    const survivors = enc.chunks.filter(c => ![1, 4, 7, 9, 12, 15].includes(c.index));
    A(survivors.length === 10, 'ten chunks survive six departures');

    let paid = 0;
    for (const c of survivors) {
        const nonce = makeChallenge();
        const ok = verifyStorageProof({
            nonce, index: c.index, data: c.data,
            answer: answerChallenge(nonce, c.data),
            proof: merkleProof(enc.chunks, c.index), root
        });
        if (ok) paid++;
    }
    A(paid === 10, 'every surviving host proves retrievability and earns its storage reward');

    const rebuilt = decodeCheckpoint(survivors, enc);
    A(Buffer.compare(Buffer.from(rebuilt), model) === 0,
      'the model is rebuilt EXACTLY after losing 6 of 16 chunks');
    A(merkleRoot(encodeCheckpoint(Buffer.from(rebuilt), { k: 10, n: 16 }).chunks) === root,
      're-encoding the rebuilt model reproduces the same on-chain root');
}

console.log('ALL ' + n + ' CHECKPOINT TESTS PASSED');
