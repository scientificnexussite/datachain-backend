// menubook.js
import chalk from 'chalk';

class MenuBook {
  constructor() {
    this.bids = []; 
    this.asks = []; 
    // Defaults to 198, but will be overwritten by DataChain history on boot
    this.lastTradePrice = 198; 
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
    const highestBid = this.bids.length > 0 ? this.bids[0].priceUsd : 0;
    const lowestAsk = this.asks.length > 0 ? this.asks[0].priceUsd : 0;
    const spread = (highestBid > 0 && lowestAsk > 0) ? (lowestAsk - highestBid) : 0;
    return { highestBid, lowestAsk, spread, lastTradePrice: this.lastTradePrice };
  }

  addLimitOrder(uid, side, amountSyr, priceUsd) {
    const order = { id: ++this.orderCounter, uid, amountSyr, priceUsd, timestamp: Date.now() };
    if (side === 'BUY') {
      this.bids.push(order);
      // Sort Highest Price first (Buyers want to pay the least, but highest bid wins)
      this.bids.sort((a, b) => b.priceUsd - a.priceUsd || a.timestamp - b.timestamp); 
    } else if (side === 'SELL') {
      this.asks.push(order);
      // Sort Lowest Price first (Sellers want the most, but lowest ask wins)
      this.asks.sort((a, b) => a.priceUsd - b.priceUsd || a.timestamp - b.timestamp); 
    }
    console.log(chalk.cyan(`[MENU BOOK] Limit ${side} added: ${amountSyr} SYR @ $${priceUsd}`));
    return order;
  }

  matchMarketOrder(uid, side, amountSyr, availableFunds, limitPrice = null) {
    let remaining = amountSyr;
    let totalUsdCost = 0;
    let trades = [];
    
    // If buying, we look at the Sells (Asks). If selling, we look at Buys (Bids).
    const book = side === 'BUY' ? this.asks : this.bids;
    let initialPrice = book.length > 0 ? book[0].priceUsd : this.lastTradePrice;

    // 1e-8 acts as Dust Protection against floating-point infinite loops
    while (remaining > 1e-8 && book.length > 0) {
      const topOrder = book[0]; 
      
      // Prevent self-trading (unless it's the system liquidity pool)
      if (topOrder.uid === uid && topOrder.uid !== 'system') break; 

      // Limit Protection: Stop if the next order is outside the user's requested price bounds
      if (limitPrice !== null) {
          if (side === 'BUY' && topOrder.priceUsd > limitPrice) break;
          if (side === 'SELL' && topOrder.priceUsd < limitPrice) break;
      }

      let tradeAmount = Math.min(remaining, topOrder.amountSyr);
      let tradeUsd = tradeAmount * topOrder.priceUsd;

      // Bound checks to ensure user doesn't overdraft their USD balance during a Market Buy
      if (side === 'BUY' && (totalUsdCost + tradeUsd) > availableFunds) {
          tradeAmount = (availableFunds - totalUsdCost) / topOrder.priceUsd;
          tradeUsd = tradeAmount * topOrder.priceUsd;
          if (tradeAmount <= 1e-8) break; 
      }

      trades.push({
        buyer: side === 'BUY' ? uid : topOrder.uid,
        seller: side === 'SELL' ? uid : topOrder.uid,
        amountSyr: tradeAmount,
        amountUsd: tradeUsd,
        price: topOrder.priceUsd
      });

      // DECENTRALIZED TICKER UPDATE: The final price of the trade becomes the global market price.
      this.lastTradePrice = topOrder.priceUsd; 
      
      totalUsdCost += tradeUsd;
      remaining -= tradeAmount;
      topOrder.amountSyr -= tradeAmount;

      // Remove the order from the book if it has been fully consumed
      if (topOrder.amountSyr <= 1e-8) {
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

  getUserOrders(uid) {
    const userBids = this.bids.filter(b => b.uid === uid).map(b => ({ ...b, side: 'BUY' }));
    const userAsks = this.asks.filter(a => a.uid === uid).map(a => ({ ...a, side: 'SELL' }));
    return [...userBids, ...userAsks].sort((a, b) => b.timestamp - a.timestamp);
  }

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
