import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import chalk from 'chalk';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import nodemailer from 'nodemailer';
import pool from './db.js';
import mempool from './mempool.js';
import { DataChain } from './datachain.js';
import validator from './validator.js';
import menuBook, { processReferralBonus } from './menubook.js'; // IMPROVEMENT 4 — static import
import './p2p.js';
import config from './config.json' with { type: 'json' };

// ─── PayPal Configuration ─────────────────────────────────────────────────────
const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE      = process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

// ─── Database Schema Init ─────────────────────────────────────────────────────
pool.query(`
    CREATE TABLE IF NOT EXISTS api_state (
        id VARCHAR(50) PRIMARY KEY,
        data JSONB
    );
    CREATE TABLE IF NOT EXISTS public_keys (
        uid VARCHAR(100) PRIMARY KEY,
        public_key TEXT
    );
    CREATE TABLE IF NOT EXISTS token_verifications (
        ticker VARCHAR(20) PRIMARY KEY,
        verification_code VARCHAR(100),
        is_verified BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS referrals (
        referred_uid VARCHAR(100) PRIMARY KEY,
        referrer_uid VARCHAR(100),
        created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS referral_earnings (
        referrer_uid VARCHAR(100),
        amount_syr DOUBLE PRECISION,
        earned_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(100),
        token VARCHAR(20),
        condition VARCHAR(10),
        target_value DOUBLE PRECISION,
        email VARCHAR(200),
        is_active BOOLEAN DEFAULT TRUE,
        created_at BIGINT
    );
    -- Task 1: Persistent domain ownership verification records.
    -- Each row represents one verification attempt (pending → verified → used).
    -- A 'verified' row is required before /mint-new-cash will proceed.
    -- After a successful deploy the row is marked 'used' so it cannot be reused
    -- for a second ticker (preventing domain squatting abuse).
    CREATE TABLE IF NOT EXISTS domain_verifications (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(100) NOT NULL,
        website_url TEXT NOT NULL,
        verification_key VARCHAR(100) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at BIGINT,
        verified_at BIGINT
    );
    -- Feature A: System Handler addresses for custom token creators.
    -- Each custom token can have one system address that auto-manages liquidity.
    -- Only the token creator can pay to generate one; the address only accepts
    -- the specific token it was created for (enforced in /tx/new).
    CREATE TABLE IF NOT EXISTS system_handlers (
        token_symbol  VARCHAR(20) PRIMARY KEY,
        system_address VARCHAR(100) NOT NULL,
        creator_uid   VARCHAR(100) NOT NULL,
        created_at    BIGINT
    );
`).catch(err => console.error(chalk.red('[DB] API State & Feature tables init failed'), err));

// P2P Marketplace Tables
pool.query(`
    CREATE TABLE IF NOT EXISTS p2p_offers (
        id SERIAL PRIMARY KEY,
        merchant_address VARCHAR(100) NOT NULL,
        asset_symbol VARCHAR(10) NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        amount_locked DOUBLE PRECISION NOT NULL DEFAULT 0,
        rate DOUBLE PRECISION NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        pay_method VARCHAR(50) NOT NULL,
        pay_details TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
        created_at BIGINT NOT NULL,
        merchant_rating DOUBLE PRECISION NOT NULL DEFAULT 5.0,
        trade_count INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS p2p_trades (
        id SERIAL PRIMARY KEY,
        offer_id INT REFERENCES p2p_offers(id),
        buyer_address VARCHAR(100) NOT NULL,
        merchant_address VARCHAR(100) NOT NULL,
        asset_symbol VARCHAR(10) NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        rate DOUBLE PRECISION NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        pay_method VARCHAR(50),
        pay_details TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        buyer_rating INT,
        merchant_rating_val INT,
        dispute_reason TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
    );
`).catch(err => console.error('[DB] P2P tables init failed', err));


// ─── Express App ──────────────────────────────────────────────────────────────
const app  = express();
app.set('trust proxy', 1);
const port = process.env.PORT || config.network.api_port;

const nexusChain  = new DataChain();

// Bootstrap SDTX stable token if not seeded
async function bootstrapSdtX() {
    await nexusChain.isInitializing;
    const sdtxBal = nexusChain.state.balances['SDTX'];
    if (!sdtxBal || Object.keys(sdtxBal).length === 0) {
        console.log('[BOOTSTRAP] Seeding SDTX liquidity pool...');
        const seedTx = {
            from: 'system',
            to: 'system',
            amount: 1000000,
            amountUsd: 1000000,
            type: 'LIQUIDITY_INIT',
            tokenSymbol: 'SDTX',
            timestamp: Date.now(),
            isSystemGenerated: true,
            description: 'SDTX stable token genesis liquidity'
        };
        await nexusChain.addBlock([seedTx], 1.0);
        console.log('[BOOTSTRAP] SDTX seeded with 1,000,000 tokens at $1.00');
    }
}
setTimeout(bootstrapSdtX, 5000);

let positionsCache = new Map();

app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
    'https://scientific-nexus-site.vercel.app',
    'https://scientific-nexus-data-chain.vercel.app',
    'https://syrpts-terminal.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

app.use(bodyParser.json({ limit: '100kb' }));

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const server = createServer(app);
const wss    = new WebSocketServer({ server });

global.broadcastWS = (event, data) => {
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(JSON.stringify({ event, data }));
    });
};

// IMPROVEMENT 1 — WebSocket PING/PONG heartbeat handler.
// The client sends { event: 'PING' } every 30 seconds; the server replies with
// { event: 'PONG' }.  This keeps connections alive through Railway's reverse
// proxy (and any other load balancer) that would otherwise silently close idle
// WebSocket connections without triggering onclose on the client.
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.event === 'PING') {
                ws.send(JSON.stringify({ event: 'PONG' }));
            }
        } catch (e) {
            // Malformed message — ignore silently
        }
    });
});

// ─── Rate Limiters ────────────────────────────────────────────────────────────
// Write limiter — kept as-is on all mutation endpoints
const txLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 50,
    keyGenerator: (req) => req.ip,
    message: { error: 'Too many transactions submitted. Please try again later.' }
});

// IMPROVEMENT 5 — Read limiter applied to public data endpoints.
// 200 req/min per IP is generous for legitimate use (charts, explorers, bots)
// while blocking the unthrottled hammering of PostgreSQL-backed read routes.
const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    keyGenerator: (req) => req.ip,
    message: { error: 'Too many read requests. Please slow down.' }
});

// ─── DER Signature Helper ─────────────────────────────────────────────────────
const rawToDer = (rawSigHex) => {
    const toStrictHexInt = (hex) => {
        while (hex.length > 2 && hex.startsWith('00')) hex = hex.substring(2);
        if (parseInt(hex.substring(0, 2), 16) >= 128) hex = '00' + hex;
        return hex;
    };
    let r = toStrictHexInt(rawSigHex.substring(0, 64));
    let s = toStrictHexInt(rawSigHex.substring(64, 128));
    let rLen = (r.length / 2).toString(16).padStart(2, '0');
    let sLen = (s.length / 2).toString(16).padStart(2, '0');
    let seq  = '02' + rLen + r + '02' + sLen + s;
    let seqLen = (seq.length / 2).toString(16).padStart(2, '0');
    return '30' + seqLen + seq;
};

// ─── ECDSA Auth Middleware ─────────────────────────────────────────────────────
const requireWeb3Auth = async (req, res, next) => {
    const { signature, publicKey, uid, ...payloadData } = req.body;
    if (!signature || !publicKey || !uid)
        return res.status(401).json({ error: 'Unauthorized: Missing Web3 ECDSA Signature.' });

    try {
        const pkRes = await pool.query('SELECT public_key FROM public_keys WHERE uid = $1', [uid]);
        if (pkRes.rows.length > 0 && pkRes.rows[0].public_key !== publicKey) {
            return res.status(401).json({ error: 'Unauthorized: Public Key mismatch for this identity.' });
        } else if (pkRes.rows.length === 0) {
            await pool.query('INSERT INTO public_keys (uid, public_key) VALUES ($1, $2)', [uid, publicKey]);
        }

        const verify = crypto.createVerify('SHA256');
        verify.update(JSON.stringify(payloadData));

        let derSignature = signature.length === 128 ? rawToDer(signature) : signature;