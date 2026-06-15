// ════════════════════════════════════════════════════════════════════════════════
// DataChain Noise Trader — GBM-based Chart Activity Engine
// ════════════════════════════════════════════════════════════════════════════════
// Generates tiny, random price ticks when no human trades occur, making
// charts look alive with realistic micro-movements.
// Uses Geometric Brownian Motion: dS = σ × S × dW
// ════════════════════════════════════════════════════════════════════════════════

import chalk from 'chalk';
import pool from './db.js';

// ─── Configuration ────────────────────────────────────────────────────────────
const TICK_INTERVAL_MIN   = 120_000;     // Minimum 2 minutes between ticks
const TICK_INTERVAL_MAX   = 300_000;     // Maximum 5 minutes between ticks
const IDLE_THRESHOLD      = 300_000;     // 5 minutes of no trades to activate
const VOLATILITY          = 0.0003;      // σ = 0.03% standard deviation per tick
const MAX_DRIFT           = 0.00005;     // ±0.005% max price change per tick
const MIN_POOL_USD        = 0.01;        // Don't simulate on empty pools

// ─── Box-Muller Normal Random ────────────────────────────────────────────────
function normalRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ─── Last Trade Tracker ──────────────────────────────────────────────────────
const lastHumanTrade = new Map();  // ticker → timestamp

export function recordHumanTrade(ticker) {
    lastHumanTrade.set(ticker.toUpperCase(), Date.now());
}

// ─── Noise Trader Engine ─────────────────────────────────────────────────────
let _state = null;
let _wss = null;
let _running = false;

/**
 * Start the noise trader. Call once at server startup.
 * @param {Object} state - The nexusChain.state object
 * @param {Object} wss - WebSocket server for broadcasting PRICE_UPDATE
 */
export function startNoiseTrader(state, wss) {
    if (_running) return;
    _state = state;
    _wss = wss;
    _running = true;

    console.log(chalk.cyan('[NOISE] GBM noise trader started (σ=0.03%, interval=2-5min)'));

    // Initial delay before first tick (30 seconds)
    setTimeout(runTick, 30_000);
}

async function runTick() {
    if (!_running || !_state) return;

    try {
        const now = Date.now();
        const tickers = Object.keys(_state.liquidityPools);

        for (const ticker of tickers) {
            // Skip SYR, SDX, SDTX (native tokens with their own price mechanisms)
            if (['SYR', 'SDX', 'SDTX'].includes(ticker)) continue;

            const lp = _state.liquidityPools[ticker];
            if (!lp) continue;

            // Get effective reserves
            const effToken = lp.tokenReserve + (lp.virtualTokenReserve || 0);
            const effUsd   = lp.usdReserve   + (lp.virtualUsdReserve   || 0);
            if (effToken <= 0 || effUsd <= MIN_POOL_USD) continue;

            // Only activate when no human has traded this token for 5+ minutes
            const lastTrade = lastHumanTrade.get(ticker) || 0;
            if (now - lastTrade < IDLE_THRESHOLD) continue;

            // ── GBM Price Change ────────────────────────────────────────────
            const currentPrice = effUsd / effToken;
            const dW = normalRandom();
            const dt = 1;  // Normalized time unit

            // dS = σ × S × dW (no drift, pure random walk)
            let dS = VOLATILITY * currentPrice * dW * Math.sqrt(dt);

            // Clamp to MAX_DRIFT to prevent outlier movements
            const maxChange = currentPrice * MAX_DRIFT;
            dS = Math.max(-maxChange, Math.min(maxChange, dS));

            // Apply the change to virtual reserves only (no real money moves)
            // Shift USD reserve by dS to change the effective price
            const usdShift = dS * effToken;

            // Ensure we don't drain virtual reserves below zero
            if (lp.virtualUsdReserve + usdShift < 0) continue;

            lp.virtualUsdReserve = Number((lp.virtualUsdReserve + usdShift).toFixed(8));

            // Calculate new price
            const newEffUsd = lp.usdReserve + lp.virtualUsdReserve;
            const newPrice = newEffUsd / effToken;

            // Record a synthetic micro-trade in the DB so charts pick it up
            const microAmount = 0.001;  // Tiny symbolic amount
            const microUsd = Number((microAmount * newPrice).toFixed(8));

            if (microUsd > 0 && microAmount > 0) {
                try {
                    await pool.query(
                        `INSERT INTO transactions (from_address, to_address, amount, amount_usd, price_usd, type, token_symbol, timestamp_ms, block_index)
                         VALUES ('noise-trader', 'noise-trader', $1, $2, $3, 'MARKET_TRADE', $4, $5, -1)`,
                        [microAmount, microUsd, newPrice, ticker, now]
                    );
                } catch { /* silent — transaction table might not have block_index */ }

                // Broadcast price update via WebSocket
                if (_wss) {
                    const msg = JSON.stringify({
                        event: 'PRICE_UPDATE',
                        data: { token: ticker, price: newPrice, timestamp: now }
                    });
                    _wss.clients.forEach(client => {
                        if (client.readyState === 1) client.send(msg);
                    });
                }
            }
        }
    } catch (err) {
        console.error(chalk.red('[NOISE] Tick error:'), err.message);
    }

    // Schedule next tick at a random interval
    if (_running) {
        const delay = TICK_INTERVAL_MIN + Math.random() * (TICK_INTERVAL_MAX - TICK_INTERVAL_MIN);
        setTimeout(runTick, delay);
    }
}

export function stopNoiseTrader() {
    _running = false;
    console.log(chalk.yellow('[NOISE] Noise trader stopped.'));
}
