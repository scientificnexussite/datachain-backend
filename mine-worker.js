import { parentPort, workerData } from 'worker_threads';
import CryptoJS from 'crypto-js';

// Solves Issue #14: Worker Thread Mining prevents Express API freezes during PoW
const { index, previousHash, timestamp, data, difficulty } = workerData;
const target = Array(difficulty + 1).join("0");

let nonce = 0;
let hash = "";

const calculateHash = (n) => {
    return CryptoJS.SHA256(
        index + previousHash + timestamp + JSON.stringify(data) + n
    ).toString();
};

while (true) {
    hash = calculateHash(nonce);
    if (hash.substring(0, difficulty) === target) {
        parentPort.postMessage({ nonce, hash });
        break;
    }
    nonce++;
}
