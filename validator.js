import chalk from 'chalk';
import crypto from 'crypto';

// ==========================================
// CRYPTOGRAPHIC BRIDGE: Converts Browser Raw Signature (IEEE P1363) to Node.js DER format
// ==========================================
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

class Validator {
  validateBlock(newBlock, previousBlock) {
    if (newBlock.previousHash !== previousBlock.hash) {
      console.log(chalk.red('[VALIDATOR] Error: Hash Link Broken.'));
      return false;
    }
    if (newBlock.hash !== newBlock.calculateHash()) {
      console.log(chalk.red('[VALIDATOR] Error: Block Data Tampered.'));
      return false;
    }
    return true;
  }

  validateTransactionPayload(tx) {
    if (!tx || typeof tx !== 'object') return false;
    if (typeof tx.from !== 'string' || tx.from.length > 256) return false; 
    if (typeof tx.to !== 'string' || tx.to.length > 256) return false;
    
    // Strict input sanitization
    if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || tx.amount <= 0 || tx.amount > 3000000000) {
        return false;
    }
    
    // Support for on-chain USD tracking
    if (!['BUY', 'SELL', 'TRANSFER', 'MINT', 'MARKET_TRADE', 'USD_DEPOSIT', 'USD_WITHDRAWAL'].includes(tx.type)) {
        return false;
    }
    
    if (tx.type === 'MARKET_TRADE' && (typeof tx.amountUsd !== 'number' || !Number.isFinite(tx.amountUsd) || tx.amountUsd <= 0)) {
        return false;
    }

    // ==========================================
    // TRUSTLESS SIGNATURE VERIFICATION
    // ==========================================
    if (tx.signature && tx.publicKey) {
        try {
            // Strip out the auth wrappers to get the exact original payload
            const { signature, publicKey, uid, ...txDataToVerify } = tx;
            
            const verify = crypto.createVerify('SHA256');
            verify.update(JSON.stringify(txDataToVerify));
            
            let derSignature = signature;
            // Translate the browser's raw signature to DER format
            if (signature.length === 128) {
                derSignature = rawToDer(signature);
            }

            const isValid = verify.verify(tx.publicKey, derSignature, 'hex');

            if (!isValid) {
                console.log(chalk.red('[VALIDATOR] Cryptographic signature rejected! Trustless validation failed.'));
                return false;
            }
        } catch (error) {
            console.log(chalk.red('[VALIDATOR] Cryptographic error processing signature.'));
            return false;
        }
    }

    return true;
  }

  validateTransaction(tx, balance) {
    if (!this.validateTransactionPayload(tx)) {
      console.log(chalk.red('[VALIDATOR] Error: Malformed Payload.'));
      return false;
    }
    if (balance < tx.amount && tx.type !== 'BUY' && tx.type !== 'MARKET_TRADE' && tx.type !== 'USD_DEPOSIT' && tx.type !== 'USD_WITHDRAWAL') {
      console.log(chalk.red('[VALIDATOR] Error: Insufficient balance.'));
      return false;
    }
    return true;
  }
}

export default new Validator();