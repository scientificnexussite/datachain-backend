// state.js
class State {
  constructor() {
    this.balances = {};  // address -> balance (in SYR)
  }

  // Apply a single transaction, return false if invalid
  applyTransaction(tx) {
    const { from, to, amount } = tx;
    
    // Special case: mining reward or initial supply
    if (from === "system") {
      this.balances[to] = (this.balances[to] || 0) + amount;
      return true;
    }

    const senderBalance = this.balances[from] || 0;
    if (senderBalance < amount) return false;
    this.balances[from] = senderBalance - amount;
    this.balances[to] = (this.balances[to] || 0) + amount;
    return true;
  }

  // Replay all transactions in chain to rebuild state
  rebuild(chain) {
    this.balances = {};
    for (const block of chain) {
      // Genesis block has no transactions (string data)
      if (typeof block.data === 'string') continue;
      for (const tx of block.data) {
        this.applyTransaction(tx);
      }
    }
  }

  // Get balance of an address
  getBalance(address) {
    return this.balances[address] || 0;
  }
}

export default State;