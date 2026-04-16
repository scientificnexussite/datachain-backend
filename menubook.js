import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const fixDust = (num) => Number(num.toFixed(8));

class MenuBook {
  constructor() {
    // ==========================================
    // UPGRADE 3: Multi-Cash Order Books
    // ==========================================
    this.books = {
        "SYR": { bids: [], asks: [], lastTradePrice: 0.01 }
    };
    this.orderCounter = 0;
    
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
    this.ordersFile = path.join(volumePath, 'orders.json');
    this.loadOrders();
  }

  _initTokenBook(token) {
      if (!this.books[token]) {
          this.books[token] = { bids: [], asks: [], lastTradePrice: 0.01 };
      }
  }

  loadOrders() {
      try {
          if (fs.existsSync(this.ordersFile)) {
              const data = JSON.parse(fs.readFileSync(this.ordersFile, 'utf8'));
              this.books = data.books || { "SYR": { bids: [], asks: [], lastTradePrice: 0.01 } };
              this.orderCounter = data.orderCounter || 0;
              console.log(chalk.green("[MENU BOOK] Orders successfully loaded from disk."));
          }
      } catch (e) {
          console.warn(chalk.yellow("[MENU BOOK] No persistent orders found, starting fresh."));
      }
  }

  async saveOrders() {
      try {
          const data = { books: this.books, orderCounter: this.orderCounter };
          await fs.promises.writeFile(this.ordersFile, JSON.stringify(data, null, 2));
      } catch (e) {
          console.error(chalk.red("[MENU BOOK] Failed to save orders to disk."));
      }
  }

  async setInitialPrice(price, token = "SYR") {
      this._initTokenBook(token);
      this.books[token].lastTradePrice = price;
      await this.saveOrders();
  }

  getLockedUsd(uid, token = "SYR") {
    this._initTokenBook(token);
    return fixDust(this.books[token].bids.filter(b => b.uid === uid).reduce((sum, b) => sum + (b.amountSyr * b.priceUsd), 0));
  }

  getLockedToken(uid, token = "SYR") {
    this._initTokenBook(token);
    return fixDust(this.books[token].asks.filter(a => a.uid === uid).reduce((sum, a) => sum + a.amountSyr, 0));
  }

  getSpread(token = "SYR") {
    this._initTokenBook(token);
    const highestBid = this.books[token].bids.length > 0 ? this.books[token].bids[0].priceUsd : 0;
    const lowestAsk = this.books[token].asks.length > 0 ? this.books[token].asks[0].priceUsd : 0;
    const spread = (highestBid > 0 && lowestAsk > 0) ? fixDust(lowestAsk - highestBid) : 0;
    return { highestBid, lowestAsk, spread, lastTradePrice: this.books[token].lastTradePrice };
  }

  async addLimitOrder(uid, side, amountSyr, priceUsd, token = "SYR") {
    this._initTokenBook(token);
    const order = { id: ++this.orderCounter, uid, amountSyr: fixDust(amountSyr), priceUsd: fixDust(priceUsd), timestamp: Date.now() };
    if (side === 'BUY') {
      this.books[token].bids.push(order);
      this.books[token].bids.sort((a, b) => b.priceUsd - a.priceUsd || a.timestamp - b.timestamp); 
    } else if (side === 'SELL') {
      this.books[token].asks.push(order);
      this.books[token].asks.sort((a, b) => a.priceUsd - b.priceUsd || a.timestamp - b.timestamp); 
    }
    await this.saveOrders();
    return order;
  }

  async matchMarketOrder(uid, side, amountSyr, availableFunds, limitPrice = null, token = "SYR") {
    this._initTokenBook(token);
    let remaining = fixDust(amountSyr);
    let totalUsdCost = 0;
    let trades = [];
    
    const targetBook = side === 'BUY' ? this.books[token].asks : this.books[token].bids;
    let initialPrice = targetBook.length > 0 ? targetBook[0].priceUsd : this.books[token].lastTradePrice;

    let bookIndex = 0;
    while (remaining > 1e-8 && bookIndex < targetBook.length) {
      const topOrder = targetBook[bookIndex]; 
      
      if (topOrder.uid === uid && topOrder.uid !== 'system') {
          bookIndex++;
          continue; 
      }

      if (limitPrice !== null) {
          if (side === 'BUY' && topOrder.priceUsd > limitPrice) break;
          if (side === 'SELL' && topOrder.priceUsd < limitPrice) break;
      }

      let tradeAmount = fixDust(Math.min(remaining, topOrder.amountSyr));
      let tradeUsd = fixDust(tradeAmount * topOrder.priceUsd);

      if (side === 'BUY' && (totalUsdCost + tradeUsd) > availableFunds) {
          tradeAmount = fixDust((availableFunds - totalUsdCost) / topOrder.priceUsd);
          tradeUsd = fixDust(tradeAmount * topOrder.priceUsd);
          if (tradeAmount <= 1e-8) break; 
      }

      trades.push({
        buyer: side === 'BUY' ? uid : topOrder.uid,
        seller: side === 'SELL' ? uid : topOrder.uid,
        amountSyr: tradeAmount,
        amountUsd: tradeUsd,
        price: topOrder.priceUsd,
        tokenSymbol: token
      });

      this.books[token].lastTradePrice = topOrder.priceUsd; 
      totalUsdCost = fixDust(totalUsdCost + tradeUsd);
      remaining = fixDust(remaining - tradeAmount);
      topOrder.amountSyr = fixDust(topOrder.amountSyr - tradeAmount);

      if (topOrder.amountSyr <= 1e-8) {
        targetBook.splice(bookIndex, 1); 
      } else {
        break;
      }

      if (side === 'BUY' && totalUsdCost >= availableFunds) break;
    }

    const finalPrice = trades.length > 0 ? trades[trades.length - 1].price : initialPrice;
    let slippage = 0;
    if (initialPrice > 0 && trades.length > 0) {
        slippage = fixDust(Math.abs(finalPrice - initialPrice) / initialPrice);
    }

    await this.saveOrders();
    return { 
      trades, remaining, totalUsdCost, slippage, 
      executedSyr: fixDust(amountSyr - remaining) 
    };
  }

  getUserOrders(uid, token = "SYR") {
    this._initTokenBook(token);
    const userBids = this.books[token].bids.filter(b => b.uid === uid).map(b => ({ ...b, side: 'BUY', tokenSymbol: token }));
    const userAsks = this.books[token].asks.filter(a => a.uid === uid).map(a => ({ ...a, side: 'SELL', tokenSymbol: token }));
    return [...userBids, ...userAsks].sort((a, b) => b.timestamp - a.timestamp);
  }

  async cancelOrder(uid, orderId, token = "SYR") {
    this._initTokenBook(token);
    const bidIndex = this.books[token].bids.findIndex(b => b.id === orderId && b.uid === uid);
    if (bidIndex !== -1) { 
        this.books[token].bids.splice(bidIndex, 1); 
        await this.saveOrders();
        return true; 
    }
    const askIndex = this.books[token].asks.findIndex(a => a.id === orderId && a.uid === uid);
    if (askIndex !== -1) { 
        this.books[token].asks.splice(askIndex, 1); 
        await this.saveOrders();
        return true; 
    }
    return false;
  }
}

export default new MenuBook();