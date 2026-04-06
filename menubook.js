// menubook.js
import chalk from 'chalk';

class MenuBook {
  constructor() {
    this.bids = []; 
    this.asks = []; 
    this.lastTradePrice = 198; // Professional starting default
    this.orderCounter = 0;
  }

  setInitialPrice(price) {
      this.lastTradePrice = price;
  }

  getLockedUsd(uid) {
    return this.bids.filter(b => b.uid === uid).reduce((sum, b) => sum + (b.amountSyr * b.priceUsd), 0);
  }

  getLockedSyr(uid) {
    return this.asks.filter(a => a.uid === uid).reduce((sum, a) => sum + a.amountSyr, 0);
  }

  getSpread() {
    // FIXED: Was missing [0] array index, which caused the NaN crash and Node Sync Error
    const highestBid = this.bids.length > 0 ? this.bids[0].priceUsd : 0;
    const lowestAsk = this.asks.length > 0 ? this.asks[0].priceUsd : 0;
    const spread = (highestBid > 0 && lowestAsk > 0) ? (lowestAsk - highestBid) : 0;
    return { highestBid, lowestAsk, spread, lastTradePrice: this.lastTradePrice };
  }

  addLimitOrder(uid, side, amountSyr, priceUsd) {
    const order = { id: ++this.orderCounter, uid, amountSyr, priceUsd, timestamp: Date.now() };
    if (side === 'BUY') {
      this.bids.push(order);
      this.bids.sort((a, b) => b.priceUsd - a.priceUsd || a.timestamp - b.timestamp); 
    } else if (side === 'SELL') {
      this.asks.push(order);
      this.asks.sort((a, b) => a.priceUsd - b.priceUsd || a.timestamp - b.timestamp); 
    }
    console.log(chalk.cyan(`[MENU BOOK] Limit ${side} added: ${amountSyr} SYR @ $${priceUsd}`));
    return order;
  }

  matchMarketOrder(uid, side, amountSyr, availableFunds, limitPrice = null) {
    let remaining = amountSyr;
    let totalUsdCost = 0;
    let trades = [];
    
    const book = side === 'BUY' ? this.asks : this.bids;
    // FIXED: Was missing [0] array index
    let initialPrice = book.length > 0 ? book[0].priceUsd : this.lastTradePrice;

    while (remaining > 0 && book.length > 0) {
      // FIXED: Was assigned to entire array instead of the first element
      const topOrder = book[0]; 
      
      if (topOrder.uid === uid && topOrder.uid !== 'system') break; 

      // Boundary execution check for limits crossing the spread
      if (limitPrice !== null) {
          if (side === 'BUY' && topOrder.priceUsd > limitPrice) break;
          if (side === 'SELL' && topOrder.priceUsd < limitPrice) break;
      }

      let tradeAmount = Math.min(remaining, topOrder.amountSyr);
      let tradeUsd = tradeAmount * topOrder.priceUsd;

      if (side === 'BUY' && (totalUsdCost + tradeUsd) > availableFunds) {
          tradeAmount = (availableFunds - totalUsdCost) / topOrder.priceUsd;
          tradeUsd = tradeAmount * topOrder.priceUsd;
          if (tradeAmount <= 0) break;
      }

      trades.push({
        buyer: side === 'BUY' ? uid : topOrder.uid,
        seller: side === 'SELL' ? uid : topOrder.uid,
        amountSyr: tradeAmount,
        amountUsd: tradeUsd,
        price: topOrder.priceUsd
      });

      this.lastTradePrice = topOrder.priceUsd; // Persistent price tracking synced with API
      totalUsdCost += tradeUsd;
      remaining -= tradeAmount;
      topOrder.amountSyr -= tradeAmount;

      if (topOrder.amountSyr <= 0) {
        book.shift(); 
      }

      if (side === 'BUY' && totalUsdCost >= availableFunds) break;
    }

    const finalPrice = trades.length > 0 ? trades[trades.length - 1].price : initialPrice;
    let slippage = 0;
    
    if (initialPrice > 0 && trades.length > 0) {
        slippage = Math.abs(finalPrice - initialPrice) / initialPrice;
    }

    return { 
      trades, 
      remaining, 
      totalUsdCost, 
      slippage, 
      executedSyr: amountSyr - remaining 
    };
  }

  // NEW: Logic to retrieve all open orders for a specific user
  getUserOrders(uid) {
    const userBids = this.bids.filter(b => b.uid === uid).map(b => ({ ...b, side: 'BUY' }));
    const userAsks = this.asks.filter(a => a.uid === uid).map(a => ({ ...a, side: 'SELL' }));
    return [...userBids, ...userAsks].sort((a, b) => b.timestamp - a.timestamp);
  }

  // NEW: Logic to remove an order from the book and refund the user
  cancelOrder(uid, orderId) {
    const bidIndex = this.bids.findIndex(b => b.id === orderId && b.uid === uid);
    if (bidIndex !== -1) { 
        this.bids.splice(bidIndex, 1); 
        return true; 
    }
    const askIndex = this.asks.findIndex(a => a.id === orderId && a.uid === uid);
    if (askIndex !== -1) { 
        this.asks.splice(askIndex, 1); 
        return true; 
    }
    return false;
  }
}

export default new MenuBook();
