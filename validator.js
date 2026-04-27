import chalk from 'chalk';
import crypto from 'crypto';

// ─── DER Encoding Helper ──────────────────────────────────────────────────────
// Converts a raw 64-byte (r || s) ECDSA signature into DER format so that
// Node's crypto.createVerify() can consume it correctly.
const rawToDer = (rawSigHex) => {
    const toStrictHexInt = (hex) => {
        while (hex.length > 2 && hex.startsWith('00')) {
            hex = hex.substring(2);
        }
        if (parseInt(hex.substring(0, 2), 16) >= 128) {
            hex = '00' + hex;
        }
        return hex;
    };
    let r = toStrictHexInt(rawSigHex.substring(0, 64));
    let s = toStrictHexInt(rawSigHex.substring(64, 128));
    let rLen = (r.length / 2).toString(16).padStart(2, '0');
    let sLen = (s.length / 2).toString(16).padStart(2, '0');
    let seq = '02' + rLen + r + '02' + sLen + s;
    let seqLen = (seq.length / 2).toString(16).padStart(2, '0');
    return '30' + seqLen + seq;
};

// ─── Validator ────────────────────────────────────────────────────────────────
class Validator {
  constructor() {
    // FIX 3 — Removed the hardcoded this.difficulty = 2.
    // Difficulty is now passed as a parameter to validateBlock() so that the
    // validator always checks against the live chain difficulty rather than a
    // stale singleton value.  This closes the consensus security hole where a
    // block mined at difficulty 2 would silently pass even when the chain had
    // advanced to difficulty 6.
  }

  // FIX 3 — Added third parameter: chainDifficulty (defaults to 2 for safety).
  // All callers in datachain.js must pass this.difficulty explicitly.
  validateBlock(newBlock, previousBlock, chainDifficulty = 2) {
    // 1) Hash-link integrity
    if (newBlock.previousHash !== previousBlock.hash) {
      console.log(chalk.red('[VALIDATOR] Error: Hash Link Broken — previousHash mismatch.'));
      return false;
    }

    // 2) Data-integrity check (recompute hash and compare)
    const validHash = newBlock.calculateHash();
    if (newBlock.hash !== validHash) {
      console.log(chalk.red('[VALIDATOR] Error: Data Tampering Detected — hash does not match block contents.'));
      return false;
    }

    // 3) Proof-of-Work target using the live chain difficulty
    const target = Array((chainDifficulty || 2) + 1).join('0');
    if (!newBlock.hash.startsWith(target)) {
      console.log(chalk.red(`[VALIDATOR] Error: Block hash does not meet difficulty target (${chainDifficulty} leading zeros required).`));
      return false;
    }

    return true;
  }

  // ── Transaction payload validation ─────────────────────────────────────────
  validateTransactionPayload(tx) {
    // Every transaction must have these four fields
    if (!tx.from || !tx.to || !tx.amount || !tx.type) return false;

    // System-generated transactions bypass cryptographic checks
    if (tx.isSystemGenerated) return true;

    // If a user transaction carries a signature + public key, verify them
    if (tx.signature && tx.publicKey) {
        try {
            // Strip authentication fields before hashing — they were not part of
            // the original signed payload on the client side.
            const { signature, publicKey, uid, ...txDataToVerify } = tx;
            const verify = crypto.createVerify('SHA256');
            verify.update(JSON.stringify(txDataToVerify));

            // Accept both raw 64-byte hex sigs and pre-encoded DER sigs
            let derSignature = signature;
            if (signature.length === 128) {
                derSignature = rawToDer(signature);
            }

            const isValid = verify.verify(tx.publicKey, derSignature, 'hex');

            if (!isValid) {
                console.log(chalk.red('[VALIDATOR] Cryptographic signature rejected! Trustless validation failed.'));
                return false;
            }
        } catch (error) {
            console.log(chalk.red('[VALIDATOR] Cryptographic error while processing transaction signature.'));
            return false;
        }
    }

    return true;
  }

  // ── Balance-aware transaction validation ───────────────────────────────────
  validateTransaction(tx, balance) {
    if (!this.validateTransactionPayload(tx)) {
      console.log(chalk.red('[VALIDATOR] Error: Malformed Payload.'));
      return false;
    }
    // Balance check is skipped for trade-type and deposit/withdrawal transactions
    // because those are authorised through separate balance guards in the API layer.
    if (
      balance < tx.amount &&
      tx.type !== 'BUY' &&
      tx.type !== 'MARKET_TRADE' &&
      tx.type !== 'USD_DEPOSIT' &&
      tx.type !== 'USD_WITHDRAWAL'
    ) {
      console.log(chalk.red('[VALIDATOR] Error: Insufficient balance.'));
      return false;
    }
    return true;
  }
}

export default new Validator();
