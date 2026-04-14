import fs from 'fs';
import path from 'path';

class State {
  constructor() {
    this.balances = {};     
    this.usd_balances = {}; 
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
    this.snapshotFile = path.join(volumePath, 'state_snapshot.json');
  }

  getUsd(address) { 
    return this.usd_balances[address] || 0; 
  }

  addUsd(address, amount) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) return;
    const current = this.getUsd(address);
    this.usd_balances[address] = current + amount;
  }

  deductUsd(address, amount) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) return false;
    const current = this.getUsd(address);
    if (address !== 'system' && current < amount) return false;
    this.usd_balances[address] = current - amount;
    return true;
  }

  // Unified validation for live transactions. Bypasses strict checks during historical replay to preserve chain integrity.
  applyTransaction(tx, currentPrice = 0, isReplay = false) {
    const { from, to, amount, type } = tx;
    
    if (type === "MINT" && from === "system") {
      this.balances[to] = (this.balances[to] || 0) + amount;
      return true;
    }

    if (type === "USD_DEPOSIT") {
        this.addUsd(to, amount);
        return true;
    }

    if (type === "USD_WITHDRAWAL") {
        if (!isReplay && !this.deductUsd(from, amount)) return false;
        if (isReplay) this.usd_balances[from] = (this.usd_balances[from] || 0) - amount;
        return true;
    }

    if (type === "MARKET_TRADE") {
        const { amountUsd } = tx;
        if (!isReplay && !this.deductUsd(to, amountUsd)) return false; 
        
        const sellerBalance = this.balances[from] || 0;
        if (!isReplay && sellerBalance < amount) return false; 
        
        if (isReplay) this.usd_balances[to] = (this.usd_balances[to] || 0) - amountUsd;
        this.balances[from] = (this.balances[from] || 0) - amount;
        this.balances[to] = (this.balances[to] || 0) + amount;
        this.addUsd(from, amountUsd);
        return true;
    }

    if (type === "BUY") {
        // Fix 6: During replay currentPrice is 0, so we must read the stored amountUsd on the tx
        // rather than recalculating cost = amount * currentPrice (which gives $0 and corrupts balances).
        const cost = tx.amountUsd !== undefined ? tx.amountUsd : (amount * currentPrice);
        if (!isReplay && !this.deductUsd(to, cost)) return false; 
        
        const sysBalance = this.balances[from] || 0;
        if (!isReplay && sysBalance < amount) return false;
        
        if (isReplay) this.usd_balances[to] = (this.usd_balances[to] || 0) - cost;
        this.balances[from] = (this.balances[from] || 0) - amount;
        this.balances[to] = (this.balances[to] || 0) + amount;
        return true;
    }

    if (type === "SELL") {
        const senderBalance = this.balances[from] || 0;
        if (!isReplay && senderBalance < amount) return false;
        
        const revenue = amount * currentPrice;
        this.addUsd(from, revenue); 
        
        this.balances[from] = (this.balances[from] || 0) - amount;
        this.balances[to] = (this.balances[to] || 0) + amount;
        return true;
    }

    // Standard Transfer
    const senderBalance = this.balances[from] || 0;
    if (!isReplay && senderBalance < amount) return false;
    
    this.balances[from] = (this.balances[from] || 0) - amount;
    this.balances[to] = (this.balances[to] || 0) + amount;
    return true;
  }

  rebuild(chain) {
    this.balances = {};
    this.usd_balances = {};
    let startIndex = 0;

    try {
        if (fs.existsSync(this.snapshotFile)) {
            const snapshot = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
            this.balances = snapshot.balances || {};
            this.usd_balances = snapshot.usd_balances || {};
            startIndex = snapshot.lastIndex + 1;
        }
    } catch (e) {
        console.warn("Failed to load state snapshot, running full replay.");
    }

    for (let i = startIndex; i < chain.length; i++) {
      const block = chain[i];
      if (typeof block.data === 'string') continue;
      for (const tx of block.data) {
        this.applyTransaction(tx, 0, true); // Flagged as Replay
      }
    }
  }

  saveSnapshot(lastIndex) {
      try {
          const snapshot = { balances: this.balances, usd_balances: this.usd_balances, lastIndex };
          fs.writeFileSync(this.snapshotFile, JSON.stringify(snapshot));
      } catch (e) {
          console.error("Snapshot save failed:", e);
      }
  }

  getBalance(address) { 
    return this.balances[address] || 0; 
  }
}

export default State;
