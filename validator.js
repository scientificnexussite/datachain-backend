import chalk from 'chalk';
import crypto from 'crypto';

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
    if (typeof tx.from !== 'string' || tx.from.length > 256) return false; // Increased length for ECDSA Public Keys
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
    // UPGRADE 1: ECDSA Cryptographic Verification
    // ==========================================
    if (tx.signature && tx.publicKey) {
        try {
            // Reconstruct the exact data payload that was signed (everything except the signature itself)
            const { signature, ...txDataToVerify } = tx;
            
            const verify = crypto.createVerify('SHA256');
            verify.update(JSON.stringify(txDataToVerify));
            
            const isValid = verify.verify(tx.publicKey, signature, 'hex');
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