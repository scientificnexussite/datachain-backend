// ════════════════════════════════════════════════════════════════════════════════
// DataChain AMM Engine — Centralized Market-Making Module
// ════════════════════════════════════════════════════════════════════════════════
// Virtual Reserves, Asymmetric Rounding, Dynamic Fees, Anti-Sandwich,
// Trade Mutex, Graduation, TWAMM-enhanced chunking.
// ════════════════════════════════════════════════════════════════════════════════

import chalk from 'chalk';
import pool from './db.js';
import { logSecurityEvent } from './security.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const VIRTUAL_USD_RESERVE     = 10_000;       // $10,000 virtual depth per new token
const GRADUATION_THRESHOLD    = 10_000;       // $10,000 real USD reserves → graduate
const BASE_FEE                = 0.0015;       // 0.15% base swap fee
const MAX_FEE                 = 0.05;         // 5% max velocity fee
const FEE_VELOCITY_WINDOW     = 60_000;       // 1-minute window for trade velocity
const SANDWICH_WINDOW_MS      = 3_000;        // 3-second anti-sandwich window
const TWAMM_THRESHOLD_USD     = 500;          // Orders > $500 get enhanced chunking
const MAX_CHUNKS              = 2000;         // Safety cap

// ─── In-Memory Stores ────────────────────────────────────────────────────────
// Trade mutex: one trade per address at a time
const tradeLocks = new Map();   // address → { promise, resolve }

// Trade velocity: per-token trade timestamps within 60s window
const tradeVelocity = new Map();  // ticker → [timestamp, ...]

// Anti-sandwich: last trade per address per token
const lastTrades = new Map();     // `${address}:${token}` → { side, timestamp }

// ─── Asymmetric Rounding ─────────────────────────────────────────────────────
// Pool always keeps the rounding dust. Makes micro-trade drain attacks impossible.
function roundDown(num)  { return Math.floor(num * 1e8) / 1e8; }   // Tokens received / USD payout
function roundUp(num)    { return Math.ceil(num * 1e8) / 1e8; }    // Cost to buyer

// ─── Trade Mutex ─────────────────────────────────────────────────────────────
// Prevents double-spend race conditions when two requests from the same wallet
// hit the server simultaneously.
export async function acquireTradeLock(address) {
    while (tradeLocks.has(address)) {
        try { await tradeLocks.get(address).promise; } catch {}
    }
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    tradeLocks.set(address, { promise, resolve });
}

export function releaseTradeLock(address) {
    const lock = tradeLocks.get(address);
    if (lock) {
        lock.resolve();
        tradeLocks.delete(address);
    }
}

// Safety: auto-release stuck locks after 30 seconds
setInterval(() => {
    const now = Date.now();
    for (const [addr, lock] of tradeLocks) {
        if (lock._created && now - lock._created > 30_000) {
            lock.resolve();
            tradeLocks.delete(addr);
            console.log(chalk.yellow(`[AMM] Auto-released stuck trade lock for ${addr.substring(0,12)}...`));
        }
    }
}, 10_000);

// ─── Anti-Sandwich Protection ────────────────────────────────────────────────
export function checkAntiSandwich(address, tokenSymbol, side) {
    const key = `${address}:${tokenSymbol}`;
    const last = lastTrades.get(key);
    const now = Date.now();

    if (last) {
        // Block if same address does BUY then SELL (or SELL then BUY) within 3 seconds
        if (last.side !== side && (now - last.timestamp) < SANDWICH_WINDOW_MS) {
            logSecurityEvent('ANTI_SANDWICH', address,
                `Blocked ${side} after ${last.side} of ${tokenSymbol} within ${now - last.timestamp}ms`,
                'critical'
            );
            return { blocked: true, reason: `Anti-sandwich: ${side} after ${last.side} within 3 seconds is not allowed.` };
        }
    }

    // Record this trade
    lastTrades.set(key, { side, timestamp: now });
    return { blocked: false };
}

// Cleanup old entries every 60 seconds
setInterval(() => {
    const cutoff = Date.now() - 30_000;
    for (const [key, data] of lastTrades) {
        if (data.timestamp < cutoff) lastTrades.delete(key);
    }
}, 60_000);

// ─── Dynamic Velocity Fees ───────────────────────────────────────────────────
// Scales swap fee from 0.15% to 5% based on trade count per minute per token.
export function getDynamicFee(tokenSymbol) {
    const now = Date.now();
    const key = tokenSymbol.toUpperCase();
    let timestamps = tradeVelocity.get(key) || [];

    // Purge entries outside the window
    timestamps = timestamps.filter(ts => now - ts < FEE_VELOCITY_WINDOW);
    tradeVelocity.set(key, timestamps);

    const count = timestamps.length;

    // Linear ramp: 0-5 trades = base, 5-30+ trades = ramp to MAX_FEE
    if (count <= 5) return BASE_FEE;
    const multiplier = Math.min((count - 5) / 25, 1);  // 0 at 5 trades, 1 at 30 trades
    return BASE_FEE + (MAX_FEE - BASE_FEE) * multiplier;
}

export function recordTradeVelocity(tokenSymbol) {
    const key = tokenSymbol.toUpperCase();
    const timestamps = tradeVelocity.get(key) || [];
    timestamps.push(Date.now());
    tradeVelocity.set(key, timestamps);
}

// ─── Virtual Reserves ────────────────────────────────────────────────────────
// Returns effective reserves (real + virtual) for pool price calculation.
// Virtual reserves create mathematical depth without real money.
export function getEffectiveReserves(lp) {
    return {
        tokenReserve: lp.tokenReserve + (lp.virtualTokenReserve || 0),
        usdReserve:   lp.usdReserve   + (lp.virtualUsdReserve   || 0)
    };
}

export function getEffectivePrice(lp) {
    const eff = getEffectiveReserves(lp);
    if (eff.tokenReserve <= 0 || eff.usdReserve <= 0) return 0;
    return roundDown(eff.usdReserve / eff.tokenReserve);
}

// Initialize virtual reserves for a new token pool
export function initVirtualReserves(lp, seedPrice) {
    if (seedPrice <= 0) return;
    // Only set virtual reserves if they haven't been set yet
    if (lp.virtualUsdReserve > 0) return;

    lp.virtualUsdReserve   = VIRTUAL_USD_RESERVE;
    lp.virtualTokenReserve = roundDown(VIRTUAL_USD_RESERVE / seedPrice);
}

// ─── Graduation Check ────────────────────────────────────────────────────────
// Returns true if the token has graduated (real reserves >= threshold).
export async function checkGraduation(tokenSymbol, lp) {
    // Only check real reserves (excluding virtual)
    if (lp.usdReserve < GRADUATION_THRESHOLD) return false;

    // Check if already graduated
    try {
        const existing = await pool.query(
            'SELECT graduated FROM open_token_supply WHERE ticker = $1',
            [tokenSymbol]
        );
        if (existing.rows.length > 0 && existing.rows[0].graduated) return false; // Already done
    } catch { /* table may not have graduated column yet */ }

    // Graduate!
    console.log(chalk.bgGreen.black(` [AMM] 🎓 TOKEN GRADUATED: ${tokenSymbol} — Real reserves: $${lp.usdReserve.toFixed(2)} `));

    try {
        // 1. Mark as graduated in DB
        await pool.query(
            `ALTER TABLE open_token_supply ADD COLUMN IF NOT EXISTS graduated BOOLEAN DEFAULT FALSE`
        ).catch(() => {});
        await pool.query(
            'UPDATE open_token_supply SET graduated = TRUE WHERE ticker = $1',
            [tokenSymbol]
        );

        // 2. Zero out virtual reserves (pool is now self-sustaining)
        lp.virtualUsdReserve   = 0;
        lp.virtualTokenReserve = 0;

        // 3. Log graduation event
        logSecurityEvent('TOKEN_GRADUATED', 'system',
            `${tokenSymbol} graduated with $${lp.usdReserve.toFixed(2)} real reserves. Virtual reserves removed. Liquidity locked permanently.`,
            'info'
        );

        return true;
    } catch (err) {
        console.error(chalk.red(`[AMM] Graduation failed for ${tokenSymbol}:`), err.message);
        return false;
    }
}

// ─── Chunked AMM Execution ───────────────────────────────────────────────────
// Enhanced chunked execution with TWAMM-style micro-chunks for large orders,
// asymmetric rounding, and dynamic fees.

/**
 * Execute a BUY order against the AMM pool.
 * @param {Object} lp - Liquidity pool state { tokenReserve, usdReserve, virtualTokenReserve, virtualUsdReserve }
 * @param {number} tokenAmount - Desired token amount
 * @param {number} maxUsdBudget - Max USD the buyer will spend
 * @param {number} maxSlippage - Max slippage tolerance (0.01 = 1%)
 * @param {string} tokenSymbol - Token ticker
 * @param {number|null} hardPeg - If set, skip AMM price discovery
 * @returns {{ fills: Array, totalTokens: number, totalUsd: number, finalPrice: number, slippageExceeded: boolean, fee: number }}
 */
export function executeBuy(lp, tokenAmount, maxUsdBudget, maxSlippage, tokenSymbol, hardPeg = null) {
    const eff = getEffectiveReserves(lp);
    if (eff.tokenReserve <= 0 || eff.usdReserve <= 0) {
        return { fills: [], totalTokens: 0, totalUsd: 0, finalPrice: 0, slippageExceeded: false, fee: 0 };
    }

    const startPrice = hardPeg || roundDown(eff.usdReserve / eff.tokenReserve);
    const dynamicFee = getDynamicFee(tokenSymbol);

    // TWAMM enhancement: smaller chunks for large orders
    const estimatedUsd = tokenAmount * startPrice;
    let chunkSize;
    if (estimatedUsd > TWAMM_THRESHOLD_USD) {
        // Whale order: use much smaller chunks (0.01% of pool) for smoother price curve
        chunkSize = Math.max(10, roundDown(eff.tokenReserve * 0.0001));
    } else {
        // Normal order: 0.1% of pool
        chunkSize = Math.max(100, roundDown(eff.tokenReserve * 0.001));
    }

    let remaining     = tokenAmount;
    let budget        = maxUsdBudget;
    let totalTokens   = 0;
    let totalUsd      = 0;
    let totalFee      = 0;
    let slippageExceeded = false;
    let chunkCount    = 0;
    const fills       = [];

    while (remaining > 1e-8 && budget > 1e-8 && chunkCount < MAX_CHUNKS) {
        chunkCount++;
        const effNow = getEffectiveReserves(lp);
        const currentPrice = hardPeg || roundDown(effNow.usdReserve / effNow.tokenReserve);

        // Slippage check
        if (!hardPeg && startPrice > 0) {
            const slip = (currentPrice - startPrice) / startPrice;
            if (slip > maxSlippage) {
                slippageExceeded = true;
                break;
            }
        }

        // Chunk fill
        let chunkFill = roundDown(Math.min(remaining, chunkSize, lp.tokenReserve));
        let chunkUsd  = roundUp(chunkFill * currentPrice);  // Round UP cost to buyer

        // Apply dynamic fee
        const feeAmount = roundUp(chunkUsd * dynamicFee);
        const totalChunkCost = roundUp(chunkUsd + feeAmount);

        // Budget check
        if (totalChunkCost > budget) {
            chunkFill = roundDown((budget / (1 + dynamicFee)) / currentPrice);
            if (chunkFill < 1e-8) break;
            chunkUsd  = roundUp(chunkFill * currentPrice);
        }
        if (chunkFill < 1e-8) break;

        const actualCost = roundUp(chunkFill * currentPrice);
        const actualFee  = roundUp(actualCost * dynamicFee);

        // Update REAL reserves (virtual stay constant until graduation)
        lp.tokenReserve = roundDown(lp.tokenReserve - chunkFill);
        lp.usdReserve   = roundDown(lp.usdReserve + actualCost);

        const newEffective = getEffectiveReserves(lp);
        const newPrice = newEffective.tokenReserve > 0
            ? roundDown(newEffective.usdReserve / newEffective.tokenReserve)
            : currentPrice;

        fills.push({
            amount: chunkFill,
            usd:    actualCost,
            fee:    actualFee,
            price:  newPrice
        });

        totalTokens += chunkFill;
        totalUsd    += actualCost + actualFee;
        totalFee    += actualFee;
        remaining    = roundDown(remaining - chunkFill);
        budget       = roundDown(budget - actualCost - actualFee);
    }

    recordTradeVelocity(tokenSymbol);

    const finalEff = getEffectiveReserves(lp);
    const finalPrice = finalEff.tokenReserve > 0
        ? roundDown(finalEff.usdReserve / finalEff.tokenReserve)
        : startPrice;

    return {
        fills,
        totalTokens: roundDown(totalTokens),
        totalUsd:    roundDown(totalUsd),
        finalPrice,
        startPrice,
        slippageExceeded,
        fee: roundDown(totalFee),
        chunkCount
    };
}

/**
 * Execute a SELL order against the AMM pool.
 * @param {Object} lp - Liquidity pool state
 * @param {number} tokenAmount - Tokens to sell
 * @param {number} maxSlippage - Max slippage tolerance
 * @param {string} tokenSymbol - Token ticker
 * @param {number|null} hardPeg - If set, skip AMM price discovery
 * @param {number} handlerUsdBal - Available USD in the system handler
 * @returns {{ fills: Array, totalTokens: number, totalUsd: number, finalPrice: number, slippageExceeded: boolean, fee: number }}
 */
export function executeSell(lp, tokenAmount, maxSlippage, tokenSymbol, hardPeg = null, handlerUsdBal = Infinity) {
    const eff = getEffectiveReserves(lp);
    if (eff.tokenReserve <= 0 || eff.usdReserve <= 0) {
        return { fills: [], totalTokens: 0, totalUsd: 0, finalPrice: 0, slippageExceeded: false, fee: 0 };
    }

    const startPrice = hardPeg || roundDown(eff.usdReserve / eff.tokenReserve);
    const dynamicFee = getDynamicFee(tokenSymbol);

    const estimatedUsd = tokenAmount * startPrice;
    let chunkSize;
    if (estimatedUsd > TWAMM_THRESHOLD_USD) {
        chunkSize = Math.max(10, roundDown(eff.tokenReserve * 0.0001));
    } else {
        chunkSize = Math.max(100, roundDown(eff.tokenReserve * 0.001));
    }

    let remaining     = tokenAmount;
    let usdBudget     = handlerUsdBal;
    let totalTokens   = 0;
    let totalUsd      = 0;
    let totalFee      = 0;
    let slippageExceeded = false;
    let chunkCount    = 0;
    const fills       = [];

    while (remaining > 1e-8 && usdBudget > 1e-8 && chunkCount < MAX_CHUNKS) {
        chunkCount++;
        const effNow = getEffectiveReserves(lp);
        const currentPrice = hardPeg || roundDown(effNow.usdReserve / effNow.tokenReserve);

        // Slippage check (reverse: price drops)
        if (!hardPeg && startPrice > 0) {
            const slip = (startPrice - currentPrice) / startPrice;
            if (slip > maxSlippage) {
                slippageExceeded = true;
                break;
            }
        }

        let chunkFill = roundDown(Math.min(remaining, chunkSize));
        let chunkUsd  = roundDown(chunkFill * currentPrice);  // Round DOWN payout to seller

        // Apply fee (deducted from payout)
        const feeAmount = roundUp(chunkUsd * dynamicFee);
        const netPayout = roundDown(chunkUsd - feeAmount);

        if (netPayout > usdBudget) {
            chunkFill = roundDown(usdBudget / currentPrice);
            if (chunkFill < 1e-8) break;
            chunkUsd  = roundDown(chunkFill * currentPrice);
        }
        if (chunkFill < 1e-8) break;

        const actualPayout = roundDown(chunkFill * currentPrice);
        const actualFee    = roundUp(actualPayout * dynamicFee);
        const userReceives = roundDown(actualPayout - actualFee);

        // Update REAL reserves
        lp.tokenReserve = roundDown(lp.tokenReserve + chunkFill);
        lp.usdReserve   = roundDown(lp.usdReserve - actualPayout);

        const newEffective = getEffectiveReserves(lp);
        const newPrice = newEffective.tokenReserve > 0
            ? roundDown(newEffective.usdReserve / newEffective.tokenReserve)
            : currentPrice;

        fills.push({
            amount: chunkFill,
            usd:    userReceives,
            fee:    actualFee,
            price:  newPrice
        });

        totalTokens += chunkFill;
        totalUsd    += userReceives;
        totalFee    += actualFee;
        remaining    = roundDown(remaining - chunkFill);
        usdBudget    = roundDown(usdBudget - actualPayout);
    }

    recordTradeVelocity(tokenSymbol);

    const finalEff = getEffectiveReserves(lp);
    const finalPrice = finalEff.tokenReserve > 0
        ? roundDown(finalEff.usdReserve / finalEff.tokenReserve)
        : startPrice;

    return {
        fills,
        totalTokens: roundDown(totalTokens),
        totalUsd:    roundDown(totalUsd),
        finalPrice,
        startPrice,
        slippageExceeded,
        fee: roundDown(totalFee),
        chunkCount
    };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
// Purge velocity tracking every 5 minutes
setInterval(() => {
    const cutoff = Date.now() - 300_000;
    for (const [token, timestamps] of tradeVelocity) {
        const filtered = timestamps.filter(ts => ts > cutoff);
        if (filtered.length === 0) tradeVelocity.delete(token);
        else tradeVelocity.set(token, filtered);
    }
}, 300_000);

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════
// Trade execution:
//   executeBuy(lp, amount, budget, slippage, token, hardPeg)
//   executeSell(lp, amount, slippage, token, hardPeg, handlerUsdBal)
//
// Security:
//   acquireTradeLock(address) / releaseTradeLock(address)
//   checkAntiSandwich(address, token, side)
//
// Pool math:
//   getEffectiveReserves(lp) / getEffectivePrice(lp)
//   initVirtualReserves(lp, seedPrice)
//   getDynamicFee(token)
//
// Graduation:
//   checkGraduation(token, lp)
// ═══════════════════════════════════════════════════════════════════════════════
