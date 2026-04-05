// validator.js
import chalk from 'chalk';

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
    if (typeof tx.from !== 'string' || tx.from.length > 64) return false;
    if (typeof tx.to !== 'string' || tx.to.length > 64) return false;
    if (typeof tx.amount !== 'number' || isNaN(tx.amount) || tx.amount <= 0) return false;
    
    if (!['BUY', 'SELL', 'TRANSFER', 'MINT', 'MARKET_TRADE'].includes(tx.type)) return false;
    
    if (tx.type === 'MARKET_TRADE' && (typeof tx.amountUsd !== 'number' || isNaN(tx.amountUsd) || tx.amountUsd <= 0)) {
        return false;
    }
    return true;
  }

  validateTransaction(tx, balance) {
    if (!this.validateTransactionPayload(tx)) {
      console.log(chalk.red('[VALIDATOR] Error: Malformed Payload.'));
      return false;
    }
    if (balance < tx.amount && tx.type !== 'BUY' && tx.type !== 'MARKET_TRADE') {
      console.log(chalk.red('[VALIDATOR] Error: Insufficient SilverCash balance.'));
      return false;
    }
    return true;
  }
}

export default new Validator();
