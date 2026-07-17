import { parentPort, workerData } from 'worker_threads';
import CryptoJS from 'crypto-js';

// Solves Issue #14: Worker Thread Mining prevents Express API freezes during PoW
const { index, previousHash, timestamp, data, merkleRoot, difficulty, targetHex, forkHeight } = workerData;
// Fork-aware acceptance (spec: DATACHAIN_DIFFICULTY_FORK.txt). DORMANT until FORK_1_HEIGHT is
// calibrated: usePostFork is false for every real index -> the OLD leading-hex-zeros test runs.
const usePostFork = (typeof forkHeight === 'number' && index >= forkHeight);
const target = Array(difficulty + 1).join("0");
const targetBig = (usePostFork && targetHex) ? BigInt('0x' + targetHex) : 0n;

// Limitation 6 FIX: Added MAX_NONCE cap so the worker exits cleanly if nonce is
// exhausted (virtually impossible but prevents an infinite loop at extreme difficulty).
// Also added a parentPort message listener so the main thread can send 'abort' to
// terminate a stuck worker cleanly on SIGTERM without killing the whole process.
const MAX_NONCE = 0x7FFFFFFF; // ~2.1 billion iterations max

let nonce = 0;
let hash = "";
let aborted = false;

// Graceful abort: main thread sends { cmd: 'abort' } to kill a long-running worker
parentPort.on('message', (msg) => {
    if (msg && msg.cmd === 'abort') {
        aborted = true;
    }
});

const calculateHash = (n) => {
    // LIMITATION 18 COMPATIBILITY: Hash the Merkle Root if provided, fallback to JSON
    const payload = merkleRoot ? merkleRoot : JSON.stringify(data);
    return CryptoJS.SHA256(
        index + previousHash + timestamp + payload + n
    ).toString();
};

while (!aborted && nonce <= MAX_NONCE) {
    hash = calculateHash(nonce);
    const ok = usePostFork ? (BigInt('0x' + hash) <= targetBig) : (hash.substring(0, difficulty) === target);
    if (ok) {
        parentPort.postMessage({ nonce, hash });
        break;
    }
    nonce++;
}

// If we exhausted nonces without finding a valid hash (extremely rare), report failure
if (nonce > MAX_NONCE && !aborted) {
    parentPort.postMessage({ nonce: 0, hash: '', exhausted: true });
}
