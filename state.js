import fs from 'fs';
import path from 'path';

const fixDust = (num) => Number(num.toFixed(8));

class State {
  constructor() {
    this.balances = { "SYR": {} };     
    this.usd_balances = {}; 
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
    this.snapshotFile = path.join(volumePath, 'state_snapshot.json');
    
    this.isSaving = false;
    this.saveQueue = false;
  }

  getUsd(address) { 
    return this.usd_balances[address] || 0; 
  }

  addUsd(address, amount) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) return;
    const current = this.getUsd(address);
    this.usd_balances[address] = fixDust(current + amount);
  }

  deductUsd(address, amount) {
    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) return false;
    const current = this.getUsd(address);
    if (address !== 'system' && current < amount) return false;
    this.usd_balances[address] = fixDust(current - amount);
    return true;
  }

  applyTransaction(tx, currentPrice = 0) {
    const { from, to, amount, type } = tx;
    const tokenSymbol = tx.tokenSymbol || "SYR"; 
    
    if (!this.balances[tokenSymbol]) this.balances[tokenSymbol] = {};

    if (type === 'MINT') {
      this.balances[tokenSymbol][to] = fixDust((this.balances[tokenSymbol][to] || 0) + amount);
      return true;
    }

    if (type === 'USD_DEPOSIT') {
      this.addUsd(to, amount);
      return true;
    }

    if (type === 'USD_WITHDRAWAL') {
      return this.deductUsd(from, amount);
    }

    const fromBalance = this.balances[tokenSymbol][from] || 0;

    if (type === 'TRANSFER') {
      if (fromBalance < amount && from !== 'system') return false;
      if (from !== 'system') this.balances[tokenSymbol][from] = fixDust(fromBalance - amount);
      this.balances[tokenSymbol][to] = fixDust((this.balances[tokenSymbol][to] || 0) + amount);
      return true;
    }

    if (type === 'MARKET_TRADE') {
      if (fromBalance < amount && from !== 'system') return false;
      const tradeUsdValue = tx.amountUsd; 

      if (to !== 'system') {
          if (!this.deductUsd(to, tradeUsdValue)) return false; 
      }

      if (from !== 'system') {
          this.balances[tokenSymbol][from] = fixDust(fromBalance - amount);
          this.addUsd(from, tradeUsdValue);
      }

      this.balances[tokenSymbol][to] = fixDust((this.balances[tokenSymbol][to] || 0) + amount);
      return true;
    }

    return false; 
  }

  getBalance(address, tokenSymbol = "SYR") {
    if (!this.balances[tokenSymbol]) return 0;
    return this.balances[tokenSymbol][address] || 0;
  }

  loadSnapshot(chain) {
    let startIndex = 0;
    try {
        if (fs.existsSync(this.snapshotFile)) {
            const snapshot = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
            this.balances = snapshot.balances || { "SYR": {} };
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
        this.applyTransaction(tx, 0); 
      }
    }
  }

  async saveSnapshot(lastIndex) {
      if (this.isSaving) {
          this.saveQueue = true;
          return;
      }
      this.isSaving = true;
      this.saveQueue = false;

      try {
          const snapshot = { balances: this.balances, usd_balances: this.usd_balances, lastIndex };
          const tempFile = this.snapshotFile + '.tmp';
          await fs.promises.writeFile(tempFile, JSON.stringify(snapshot));
          await fs.promises.rename(tempFile, this.snapshotFile);
      } catch (e) {
          console.error("Snapshot save failed:", e);
      } finally {
          this.isSaving = false;
          if (this.saveQueue) this.saveSnapshot(lastIndex);
      }
  }
}

export default State;