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

  // Unified validation for both live and historical transactions
  applyTransaction(tx, currentPrice = 0) {
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
        return this.deductUsd(from, amount);
    }

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

    if (type === "BUY") {
        const cost = amount * currentPrice;
        if (!this.deductUsd(to, cost)) return false; 
        
        const sysBalance = this.balances[from] || 0;
        if (sysBalance < amount) return false;
        
        this.balances[from] = sysBalance - amount;
        this.balances[to] = (this.balances[to] || 0) + amount;
        return true;
    }

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
    this.usd_balances = {};
    let startIndex = 0;

    // Snapshot restoration
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
        this.applyTransaction(tx); 
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
