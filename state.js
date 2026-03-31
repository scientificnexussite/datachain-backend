// state.js
class State {
  constructor() {
    this.balances = {};     // address -> balance (in SYR)
    this.usd_balances = {}; // NEW: address -> balance (in USD)
  }

  // ======================== NEW: USD METHODS ========================
  getUsd(address) {
    return this.usd_balances[address] || 0;
  }

  addUsd(address, amount) {
    const current = this.getUsd(address);
    this.usd_balances[address] = current + parseFloat(amount);
  }

  setUsd(address, amount) {
    this.usd_balances[address] = parseFloat(amount);
  }

  // ======================== SYR TRANSACTIONS ========================
  // Apply a single transaction, return false if invalid
  applyTransaction(tx) {
    const { from, to, amount, type } = tx;
    
    // Only allow creation of coins out of thin air during the initial Genesis MINT
    if (type === "MINT" && from === "system" && to === "system") {
      this.balances[to] = (this.balances[to] || 0) + amount;
      return true;
    }

    // For all other transactions (including buying from system), properly deduct balance
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
