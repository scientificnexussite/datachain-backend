// menubook.js
import chalk from 'chalk';

class MenuBook {
  constructor() {
    this.bids = []; // Buyers (USD ready to spend)
    this.asks = []; // Sellers (SYR ready to sell)
    this.lastTradePrice = 0;
    this.orderCounter = 0;
  }

  // Calculate funds tied up in open limit orders
  getLockedUsd(uid) {
    return this.bids.filter(b => b.uid === uid).reduce((sum, b) => sum + (b.amountSyr * b.priceUsd), 0);
  }

  getLockedSyr(uid) {
    return this.asks.filter(a => a.uid === uid).reduce((sum, a) => sum + a.amountSyr, 0);
  }

  // Determine the Bid/Ask Spread
  getSpread() {
    const highestBid = this.bids.length > 0 ? this.bids.priceUsd : 0;
    const lowestAsk = this.asks.length > 0 ? this.asks.priceUsd : 0;
    const spread = (highestBid > 0 && lowestAsk > 0) ? (lowestAsk - highestBid) : 0;
    return { highestBid, lowestAsk, spread, lastTradePrice: this.lastTradePrice };
  }

  addLimitOrder(uid, side, amountSyr, priceUsd) {
    const order = { id: ++this.orderCounter, uid, amountSyr, priceUsd, timestamp: Date.now() };
    if (side === 'BUY') {
      this.bids.push(order);
      // Sort Bids descending (highest price first)
      this.bids.sort((a, b) => b.priceUsd - a.priceUsd || a.timestamp - b.timestamp); 
    } else if (side === 'SELL') {
      this.asks.push(order);
      // Sort Asks ascending (lowest price first)
      this.asks.sort((a, b) => a.priceUsd - b.priceUsd || a.timestamp - b.timestamp); 
    }
    console.log(chalk.cyan(`[MENU BOOK] Limit ${side} added: ${amountSyr} SYR @ $${priceUsd}`));
    return order;
  }

  // Matches a market order against the Menu Book and calculates slippage
  matchMarketOrder(uid, side, amountSyr, availableFunds) {
    let remaining = amountSyr;
    let totalUsdCost = 0;
    let trades = [];
    let initialPrice = 0;

    const book = side === 'BUY' ? this.asks : this.bids;
    if (book.length > 0) initialPrice = book.priceUsd;

    while (remaining > 0 && book.length > 0) {
      const topOrder = book;
      
      // Prevent wash trading (matching against your own orders)
      if (topOrder.uid === uid) break; 

      let tradeAmount = Math.min(remaining, topOrder.amountSyr);
      let tradeUsd = tradeAmount * topOrder.priceUsd;

      // Ensure buyer doesn't exceed available USD during execution
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

      this.lastTradePrice = topOrder.priceUsd;
      totalUsdCost += tradeUsd;
      remaining -= tradeAmount;
      topOrder.amountSyr -= tradeAmount;

      if (topOrder.amountSyr <= 0) {
        book.shift(); // Remove filled order from the book
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
}

export default new MenuBook();
