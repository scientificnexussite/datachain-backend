import { parentPort, workerData } from 'worker_threads';
import CryptoJS from 'crypto-js';

// Solves Issue #14: Worker Thread Mining prevents Express API freezes during PoW
const { index, previousHash, timestamp, data, difficulty } = workerData;
const target = Array(difficulty + 1).join("0");

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
    return CryptoJS.SHA256(
        index + previousHash + timestamp + JSON.stringify(data) + n
    ).toString();
};

while (!aborted && nonce <= MAX_NONCE) {
    hash = calculateHash(nonce);
    if (hash.substring(0, difficulty) === target) {
        parentPort.postMessage({ nonce, hash });
        break;
    }
    nonce++;
}

// If we exhausted nonces without finding a valid hash (extremely rare), report failure
if (nonce > MAX_NONCE && !aborted) {
    parentPort.postMessage({ nonce: 0, hash: '', exhausted: true });
}
