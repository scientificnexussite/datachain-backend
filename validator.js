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

  validateTransaction(tx, balance) {
    if (tx.amount <= 0) {
      console.log(chalk.red('[VALIDATOR] Error: Amount must be positive.'));
      return false;
    }
    if (balance < tx.amount) {
      console.log(chalk.red('[VALIDATOR] Error: Insufficient SilverCash balance.'));
      return false;
    }
    return true;
  }
}

export default new Validator();