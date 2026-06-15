// ════════════════════════════════════════════════════════════════════════════════
// DataChain TWAP Oracle — Time-Weighted Average Price
// ════════════════════════════════════════════════════════════════════════════════
// Prevents flash-loan price manipulation by providing a rolling 30-minute
// average price instead of instantaneous spot price.
// External systems (game servers, FDX verification) read TWAP, not spot.
// ════════════════════════════════════════════════════════════════════════════════

import chalk from 'chalk';

// ─── Configuration ────────────────────────────────────────────────────────────
const TWAP_WINDOW_MS = 30 * 60 * 1000;  // 30-minute rolling window

// ─── In-Memory Price Accumulator ─────────────────────────────────────────────
// Per-token array of { price, timestamp } observations
const priceHistory = new Map();  // ticker → [{ price, timestamp }, ...]

/**
 * Record a price observation after every trade.
 * Call this from the trade execution path.
 */
export function updateTWAP(ticker, price) {
    const key = ticker.toUpperCase();
    if (price <= 0) return;

    let history = priceHistory.get(key);
    if (!history) {
        history = [];
        priceHistory.set(key, history);
    }

    history.push({ price, timestamp: Date.now() });

    // Purge entries outside the window to prevent memory growth
    const cutoff = Date.now() - TWAP_WINDOW_MS;
    const idx = history.findIndex(h => h.timestamp >= cutoff);
    if (idx > 0) history.splice(0, idx);
}

/**
 * Get the TWAP (Time-Weighted Average Price) for a token.
 * Returns the 30-minute weighted average, or the last known price if no window data.
 *
 * TWAP = Σ(price × Δt) / total_Δt
 */
export function getTWAP(ticker) {
    const key = ticker.toUpperCase();
    const history = priceHistory.get(key);

    if (!history || history.length === 0) return 0;
    if (history.length === 1) return history[0].price;

    const now = Date.now();
    const cutoff = now - TWAP_WINDOW_MS;

    // Filter to entries within the window
    const windowEntries = history.filter(h => h.timestamp >= cutoff);
    if (windowEntries.length === 0) {
        // All entries are older than the window — return the most recent
        return history[history.length - 1].price;
    }
    if (windowEntries.length === 1) return windowEntries[0].price;

    // Time-weighted calculation
    let weightedSum = 0;
    let totalDuration = 0;

    for (let i = 0; i < windowEntries.length - 1; i++) {
        const dt = windowEntries[i + 1].timestamp - windowEntries[i].timestamp;
        weightedSum += windowEntries[i].price * dt;
        totalDuration += dt;
    }

    // Last entry extends to "now"
    const lastEntry = windowEntries[windowEntries.length - 1];
    const dtLast = now - lastEntry.timestamp;
    weightedSum += lastEntry.price * dtLast;
    totalDuration += dtLast;

    if (totalDuration <= 0) return lastEntry.price;

    return Number((weightedSum / totalDuration).toFixed(8));
}

/**
 * Get the current spot price vs TWAP deviation.
 * Useful for detecting manipulation attempts.
 * Returns percentage deviation (positive = spot above TWAP).
 */
export function getTWAPDeviation(ticker, spotPrice) {
    const twap = getTWAP(ticker);
    if (twap <= 0 || spotPrice <= 0) return 0;
    return ((spotPrice - twap) / twap) * 100;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
// Purge stale entries every 10 minutes
setInterval(() => {
    const cutoff = Date.now() - TWAP_WINDOW_MS * 2;  // Keep 2× window for safety
    for (const [ticker, history] of priceHistory) {
        const filtered = history.filter(h => h.timestamp >= cutoff);
        if (filtered.length === 0) {
            priceHistory.delete(ticker);
        } else {
            priceHistory.set(ticker, filtered);
        }
    }
}, 600_000);

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════
//   updateTWAP(ticker, price)      — Record a price observation after every trade
//   getTWAP(ticker)                — Get the 30-minute time-weighted average price
//   getTWAPDeviation(ticker, spot) — Get % deviation of spot from TWAP
// ═══════════════════════════════════════════════════════════════════════════════
