// state.js
class State {
  constructor() {
    this.balances = {};     
    this.usd_balances = {}; 
  }

  getUsd(address) { return this.usd_balances[address] || 0; }

  addUsd(address, amount) {
    if (typeof amount !== 'number' || amount <= 0) return;
    const current = this.getUsd(address);
    this.usd_balances[address] = current + amount;
  }

  deductUsd(address, amount) {
    if (typeof amount !== 'number' || amount <= 0) return false;
    const current = this.getUsd(address);
    if (current < amount) return false;
    this.usd_balances[address] = current - amount;
    return true;
  }

  // FIX: Bypasses USD checks during server reboot to restore your 5.98B SilverCash
  applyHistoricalTransaction(tx) {
    const { from, to, amount, type } = tx;
    
    if (type === "MINT" && from === "system" && to === "system") {
      this.balances[to] = (this.balances[to] || 0) + amount;
      return true;
    }

    if (type === "MARKET_TRADE" || type === "BUY" || type === "SELL" || type === "TRANSFER") {
        this.balances[from] = (this.balances[from] || 0) - amount;
        this.balances[to] = (this.balances[to] || 0) + amount;
        return true;
    }
    return true;
  }

  // Apply a single transaction, return false if invalid.
  // Passed currentPrice to handle the fiat/crypto exchange properly.
  applyTransaction(tx, currentPrice = 0) {
    const { from, to, amount, type } = tx;
    
    if (type === "MINT" && from === "system" && to === "system") {
      this.balances[to] = (this.balances[to] || 0) + amount;
      return true;
    }

    // Handle Menu Book Market Trades (Peer-to-Peer)
    if (type === "MARKET_TRADE") {
        const { amountUsd } = tx;
        if (!this.deductUsd(to, amountUsd)) return false; 
        
        const sellerBalance = this.balances[from] || 0;
        if (sellerBalance < amount) return false; 
        
        this.balances[from] = sellerBalance - amount;
        this.balances[to] = (this.balances[to] || 0) + amount;
        this.addUsd(from, amountUsd);
        return true;
    }

    // Legacy: Handle USD state for BUY orders (System Liquidity)
    if (type === "BUY") {
        const cost = amount * currentPrice;
        if (!this.deductUsd(to, cost)) return false; 
        
        const sysBalance = this.balances[from] || 0;
        if (sysBalance < amount) return false;
        
        this.balances[from] = sysBalance - amount;
        this.balances[to] = (this.balances[to] || 0) + amount;
        return true;
    }

    // Legacy: Handle USD state for SELL orders (System Liquidity)
    if (type === "SELL") {
        const senderBalance = this.balances[from] || 0;
        if (senderBalance < amount) return false;
        
        const revenue = amount * currentPrice;
        this.addUsd(from, revenue); 
        
        this.balances[from] = senderBalance - amount;
        this.balances[to] = (this.balances[to] || 0) + amount;
        return true;
    }

    // Standard Transfer
    const senderBalance = this.balances[from] || 0;
    if (senderBalance < amount) return false;
    
    this.balances[from] = senderBalance - amount;
    this.balances[to] = (this.balances[to] || 0) + amount;
    return true;
  }

  rebuild(chain) {
    this.balances = {};
    for (const block of chain) {
      if (typeof block.data === 'string') continue;
      for (const tx of block.data) {
        // FIX: Use the historical applier so your past balances are correctly loaded
        this.applyHistoricalTransaction(tx); 
      }
    }
  }

  getBalance(address) { return this.balances[address] || 0; }
}

export default State;
