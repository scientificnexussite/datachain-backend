import chalk from 'chalk';
import crypto from 'crypto';

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
    
    const validHash = newBlock.calculateHash();
    if (newBlock.hash !== validHash) {
      console.log(chalk.red('[VALIDATOR] Error: Data Tampering Detected.'));
      return false;
    }
    return true;
  }

  validateTransactionPayload(tx) {
    if (!tx.from || !tx.to || !tx.amount || !tx.type) return false;
    
    if (tx.isSystemGenerated) return true;

    if (tx.signature && tx.publicKey) {
        try {
            const { signature, publicKey, uid, ...txDataToVerify } = tx;
            const verify = crypto.createVerify('SHA256');
            verify.update(JSON.stringify(txDataToVerify));
            
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