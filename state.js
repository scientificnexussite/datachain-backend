// state.js
class State {
  constructor() {
    this.balances = {};  // address -> balance (in SYR)
  }

  // Apply a single transaction, return false if invalid
  applyTransaction(tx) {
    const { from, to, amount, type } = tx;
    
    // FIX: Only allow creation of coins out of thin air during the initial Genesis MINT
    if (type === "MINT" && from === "system" && to === "system") {
      this.balances[to] = (this.balances[to] || 0) + amount;
      return true;
    }

    // FIX: For all other transactions (including buying from system), properly deduct balance
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
