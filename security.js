// ════════════════════════════════════════════════════════════════════════════════
// DataChain Security Middleware — 6-Layer Defense System
// ════════════════════════════════════════════════════════════════════════════════
// Layer 1: Per-IP Anomaly Detection
// Layer 2: WebSocket Rate Limiting & Message Validation
// Layer 3: Input Sanitization (SQL injection / XSS)
// Layer 4: Brute-Force Shield (auth failure tracking)
// Layer 5: Security Event Logger (console + PostgreSQL)
// Layer 6: DDoS Auto-Ban (in-memory IP banning)
// ════════════════════════════════════════════════════════════════════════════════

import chalk from 'chalk';
import pool from './db.js';

// ─── Database Schema ──────────────────────────────────────────────────────────
pool.query(`
    CREATE TABLE IF NOT EXISTS security_events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        ip_address VARCHAR(50),
        details TEXT,
        severity VARCHAR(10) DEFAULT 'warn',
        created_at BIGINT NOT NULL
    );
`).then(() => {
    console.log(chalk.green('[SECURITY] security_events table ready.'));
}).catch(err => {
    console.error(chalk.red('[SECURITY] Failed to create security_events table:'), err.message);
});

// ─── In-Memory Stores ────────────────────────────────────────────────────────
// All stores reset on deploy (intentional — Railway redeploy = clean slate)

// Layer 6: Banned IPs → { unbanAt: timestamp }
const bannedIPs = new Map();

// Layer 6: Rejection counter → { count, windowStart }
const rejectionTracker = new Map();

// Layer 1: Request pattern tracker → { authAttempts: [{ts}], walletSet: Set }
const ipPatterns = new Map();

// Layer 4: Auth failure tracker → { failures: [{ts}], blockedUntil: 0 }
const authFailures = new Map();

// ─── Constants ────────────────────────────────────────────────────────────────
const BAN_THRESHOLD       = 5;       // rejections before ban
const BAN_WINDOW_MS       = 60000;   // 1 minute window
const BAN_DURATION_MS     = 900000;  // 15 minutes ban

const ANOMALY_AUTH_MAX    = 5;       // max auth attempts per window
const ANOMALY_AUTH_WINDOW = 30000;   // 30 seconds
const ANOMALY_WALLET_MAX  = 3;       // max different wallets per window
const ANOMALY_WALLET_WINDOW = 60000; // 1 minute

const BRUTE_MAX_FAILURES  = 5;       // max failed auths
const BRUTE_WINDOW_MS     = 300000;  // 5 minute window
const BRUTE_BLOCK_MS      = 600000;  // 10 minute block

const WS_MAX_MSGS_PER_MIN = 30;
const WS_MAX_MSG_SIZE     = 1048576; // 1MB
const WS_MAX_VIOLATIONS   = 3;

// SQL injection patterns (case insensitive)
const SQL_INJECTION_PATTERNS = [
    /('\s*(OR|AND)\s+['"]?\d+['"]?\s*=\s*['"]?\d+)/i,
    /(UNION\s+(ALL\s+)?SELECT)/i,
    /(;\s*(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE)\s)/i,
    /(--\s*$)/m,
    /(\bEXEC\s*\()/i,
    /(\/\*.*\*\/)/,
    /(xp_cmdshell|sp_executesql|INFORMATION_SCHEMA)/i,
    /(WAITFOR\s+DELAY)/i,
    /(BENCHMARK\s*\()/i,
];

// XSS patterns
const XSS_PATTERNS = [
    /<script[\s>]/i,
    /javascript\s*:/i,
    /on(load|error|click|mouseover|focus|blur|submit|change)\s*=/i,
    /<iframe[\s>]/i,
    /<object[\s>]/i,
    /<embed[\s>]/i,
    /<svg[\s>].*on\w+\s*=/i,
];

// Fields to NEVER sanitize (signatures, keys, hashes)
const PROTECTED_FIELDS = new Set([
    'signature', 'publicKey', 'public_key', 'hash', 'previousHash',
    'merkleRoot', 'nonce', 'uid', 'api_key', 'apiKey',
    'verification_key', 'verificationKey', 'mnemonic',
    'logo_base64', 'logoBase64',
]);

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 5: Security Event Logger
// ════════════════════════════════════════════════════════════════════════════════
export function logSecurityEvent(eventType, ip, details, severity = 'warn') {
    // Console output (matches existing chalk style)
    const label = `[SECURITY] ${eventType}`;
    const msg = `${label}: ${details} (IP: ${ip || 'unknown'})`;

    if (severity === 'critical') {
        console.log(chalk.bgRed.white(` ${msg} `));
    } else if (severity === 'warn') {
        console.log(chalk.red(msg));
    } else {
        console.log(chalk.yellow(msg));
    }

    // Persist to PostgreSQL (fire-and-forget)
    pool.query(
        `INSERT INTO security_events (event_type, ip_address, details, severity, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [eventType, ip || 'unknown', details, severity, Date.now()]
    ).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 6: DDoS Auto-Ban Middleware
// ════════════════════════════════════════════════════════════════════════════════
// Runs FIRST in the middleware stack — fastest rejection path.
// Banned IPs get an immediate 403 with zero route processing.
export function autoban(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';

    // Check if IP is currently banned
    const ban = bannedIPs.get(ip);
    if (ban) {
        if (Date.now() < ban.unbanAt) {
            return res.status(403).json({
                error: 'Access denied. Your IP has been temporarily blocked due to suspicious activity.',
                retryAfter: Math.ceil((ban.unbanAt - Date.now()) / 1000)
            });
        }
        // Ban expired — remove it
        bannedIPs.delete(ip);
        logSecurityEvent('IP_UNBANNED', ip, 'Ban expired, access restored.', 'info');
    }

    // Hook into response to track rejections (4xx/5xx responses)
    const originalEnd = res.end;
    res.end = function (...args) {
        if (res.statusCode >= 400 && res.statusCode < 500) {
            trackRejection(ip);
        }
        return originalEnd.apply(this, args);
    };

    next();
}

function trackRejection(ip) {
    const now = Date.now();
    let tracker = rejectionTracker.get(ip);

    if (!tracker || now - tracker.windowStart > BAN_WINDOW_MS) {
        tracker = { count: 0, windowStart: now };
    }

    tracker.count++;
    rejectionTracker.set(ip, tracker);

    if (tracker.count >= BAN_THRESHOLD) {
        bannedIPs.set(ip, { unbanAt: now + BAN_DURATION_MS });
        rejectionTracker.delete(ip);
        logSecurityEvent('IP_BANNED', ip,
            `Auto-banned for 15 minutes after ${BAN_THRESHOLD} rejections in ${BAN_WINDOW_MS / 1000}s.`,
            'critical'
        );
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 3: Input Sanitization Middleware
// ════════════════════════════════════════════════════════════════════════════════
// Recursively inspects all string fields in req.body and req.query.
// SQL injection → blocks the request entirely (400).
// XSS → strips the malicious content silently and continues.
export function sanitize(req, res, next) {
    const ip = req.ip || 'unknown';

    // Only inspect methods that carry payloads
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        if (req.body && typeof req.body === 'object') {
            const sqlResult = checkForSQLInjection(req.body, ip);
            if (sqlResult.blocked) {
                logSecurityEvent('SQL_INJECTION_ATTEMPT', ip,
                    `Blocked SQL injection in field "${sqlResult.field}": ${sqlResult.match}`,
                    'critical'
                );
                return res.status(400).json({
                    error: 'Security Alert: Malicious input detected and blocked.'
                });
            }
            req.body = stripXSS(req.body, ip);
        }
    }

    // Check query params too
    if (req.query && typeof req.query === 'object') {
        const sqlResult = checkForSQLInjection(req.query, ip);
        if (sqlResult.blocked) {
            logSecurityEvent('SQL_INJECTION_ATTEMPT', ip,
                `Blocked SQL injection in query param "${sqlResult.field}"`,
                'critical'
            );
            return res.status(400).json({
                error: 'Security Alert: Malicious input detected and blocked.'
            });
        }
        req.query = stripXSS(req.query, ip);
    }

    next();
}

function checkForSQLInjection(obj, ip, path = '') {
    for (const [key, value] of Object.entries(obj)) {
        const fieldPath = path ? `${path}.${key}` : key;

        // Skip protected fields (signatures, keys, etc.)
        if (PROTECTED_FIELDS.has(key)) continue;

        if (typeof value === 'string') {
            for (const pattern of SQL_INJECTION_PATTERNS) {
                const match = value.match(pattern);
                if (match) {
                    return { blocked: true, field: fieldPath, match: match[0].substring(0, 50) };
                }
            }
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            const nested = checkForSQLInjection(value, ip, fieldPath);
            if (nested.blocked) return nested;
        }
    }
    return { blocked: false };
}

function stripXSS(obj, ip) {
    if (typeof obj !== 'object' || obj === null) return obj;

    const cleaned = Array.isArray(obj) ? [...obj] : { ...obj };

    for (const [key, value] of Object.entries(cleaned)) {
        if (PROTECTED_FIELDS.has(key)) continue;

        if (typeof value === 'string') {
            let sanitized = value;
            let wasModified = false;

            for (const pattern of XSS_PATTERNS) {
                if (pattern.test(sanitized)) {
                    sanitized = sanitized.replace(pattern, '[XSS_REMOVED]');
                    wasModified = true;
                }
            }

            if (wasModified) {
                logSecurityEvent('XSS_STRIPPED', ip,
                    `XSS content stripped from field "${key}"`,
                    'info'
                );
            }

            cleaned[key] = sanitized;
        } else if (typeof value === 'object' && value !== null) {
            cleaned[key] = stripXSS(value, ip);
        }
    }

    return cleaned;
}

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 1: Per-IP Anomaly Detection Middleware
// ════════════════════════════════════════════════════════════════════════════════
// Detects credential stuffing (many auth requests in short time) and
// wallet enumeration (same IP trying multiple wallet addresses).
export function anomalyDetect(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();

    // Only monitor auth-related endpoints
    const isAuthEndpoint = req.body && (req.body.signature || req.body.publicKey);
    if (!isAuthEndpoint) return next();

    let pattern = ipPatterns.get(ip);
    if (!pattern) {
        pattern = { authAttempts: [], walletSet: new Map() };
        ipPatterns.set(ip, pattern);
    }

    // Clean old entries
    pattern.authAttempts = pattern.authAttempts.filter(ts => now - ts < ANOMALY_AUTH_WINDOW);

    // Track this auth attempt
    pattern.authAttempts.push(now);

    // Track unique wallet addresses (UIDs) per IP
    const uid = req.body.uid;
    if (uid) {
        pattern.walletSet.set(uid, now);
        // Clean wallet entries older than the window
        for (const [walletUid, ts] of pattern.walletSet) {
            if (now - ts > ANOMALY_WALLET_WINDOW) pattern.walletSet.delete(walletUid);
        }
    }

    ipPatterns.set(ip, pattern);

    // Check: Too many auth attempts in window (credential stuffing)
    if (pattern.authAttempts.length > ANOMALY_AUTH_MAX) {
        logSecurityEvent('ANOMALY_DETECTED', ip,
            `Credential stuffing: ${pattern.authAttempts.length} auth attempts in ${ANOMALY_AUTH_WINDOW / 1000}s`,
            'critical'
        );
        return res.status(403).json({
            error: 'Security Alert: Unusual authentication pattern detected. Please slow down.'
        });
    }

    // Check: Too many unique wallets from same IP (enumeration)
    if (pattern.walletSet.size > ANOMALY_WALLET_MAX) {
        logSecurityEvent('ANOMALY_DETECTED', ip,
            `Wallet enumeration: ${pattern.walletSet.size} different wallets from single IP in ${ANOMALY_WALLET_WINDOW / 1000}s`,
            'warn'
        );
        return res.status(403).json({
            error: 'Security Alert: Too many wallet addresses from your IP. Please try again later.'
        });
    }

    next();
}

// Periodic cleanup (every 5 minutes) to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    const cutoff = now - 300000; // 5 minutes

    // Clean IP patterns
    for (const [ip, pattern] of ipPatterns) {
        pattern.authAttempts = pattern.authAttempts.filter(ts => ts > cutoff);
        for (const [uid, ts] of pattern.walletSet) {
            if (ts < cutoff) pattern.walletSet.delete(uid);
        }
        if (pattern.authAttempts.length === 0 && pattern.walletSet.size === 0) {
            ipPatterns.delete(ip);
        }
    }

    // Clean rejection tracker
    for (const [ip, tracker] of rejectionTracker) {
        if (now - tracker.windowStart > BAN_WINDOW_MS) rejectionTracker.delete(ip);
    }

    // Clean expired bans
    for (const [ip, ban] of bannedIPs) {
        if (now >= ban.unbanAt) bannedIPs.delete(ip);
    }

    // Clean auth failure tracker
    for (const [ip, data] of authFailures) {
        if (data.blockedUntil && now >= data.blockedUntil) {
            authFailures.delete(ip);
        } else {
            data.failures = data.failures.filter(ts => now - ts < BRUTE_WINDOW_MS);
            if (data.failures.length === 0) authFailures.delete(ip);
        }
    }
}, 300000);

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 4: Brute-Force Shield Middleware
// ════════════════════════════════════════════════════════════════════════════════
// Sits BEFORE requireWeb3Auth on sensitive routes. After 5 failed signature
// verifications from the same IP in 5 minutes, blocks for 10 minutes.
export function bruteForceGuard(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();

    const data = authFailures.get(ip);
    if (data && data.blockedUntil && now < data.blockedUntil) {
        const retryAfter = Math.ceil((data.blockedUntil - now) / 1000);
        logSecurityEvent('AUTH_BRUTE_FORCE', ip,
            `Blocked auth attempt (still blocked for ${retryAfter}s)`,
            'warn'
        );
        return res.status(403).json({
            error: 'Too many failed authentication attempts. Please wait before trying again.',
            retryAfter
        });
    }

    // Hook into response — if the auth middleware returns 401, count it as a failure
    const originalJson = res.json.bind(res);
    res.json = function (body) {
        if (res.statusCode === 401) {
            recordAuthFailure(ip);
        }
        return originalJson(body);
    };

    next();
}

function recordAuthFailure(ip) {
    const now = Date.now();
    let data = authFailures.get(ip);
    if (!data) {
        data = { failures: [], blockedUntil: 0 };
    }

    // Clean old failures
    data.failures = data.failures.filter(ts => now - ts < BRUTE_WINDOW_MS);
    data.failures.push(now);

    if (data.failures.length >= BRUTE_MAX_FAILURES) {
        data.blockedUntil = now + BRUTE_BLOCK_MS;
        data.failures = [];
        logSecurityEvent('AUTH_BRUTE_FORCE', ip,
            `IP blocked for ${BRUTE_BLOCK_MS / 60000} minutes after ${BRUTE_MAX_FAILURES} failed auth attempts.`,
            'critical'
        );
    }

    authFailures.set(ip, data);
}

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 2: WebSocket Guard
// ════════════════════════════════════════════════════════════════════════════════
// Call guardWebSocket(ws) on each new WebSocket connection.
// Enforces per-connection message rate (30/min) and max size (1MB).
// Auto-disconnects after 3 violations.
export function guardWebSocket(ws) {
    let messageCount  = 0;
    let violations    = 0;
    let windowStart   = Date.now();
    const wsIp = ws._socket?.remoteAddress || 'unknown';

    // Store the original .on('message') handler registerer
    const originalOn = ws.on.bind(ws);

    // Override message handling
    ws.on = function (event, handler) {
        if (event === 'message') {
            // Wrap the message handler with rate limiting
            return originalOn(event, (raw) => {
                const now = Date.now();

                // Reset window every minute
                if (now - windowStart > 60000) {
                    messageCount = 0;
                    windowStart = now;
                }

                messageCount++;

                // Check message rate
                if (messageCount > WS_MAX_MSGS_PER_MIN) {
                    violations++;
                    logSecurityEvent('WS_FLOOD', wsIp,
                        `WebSocket flood: ${messageCount} msgs/min (violation ${violations}/${WS_MAX_VIOLATIONS})`,
                        'warn'
                    );

                    if (violations >= WS_MAX_VIOLATIONS) {
                        logSecurityEvent('WS_FLOOD', wsIp,
                            'WebSocket disconnected after repeated flooding.',
                            'critical'
                        );
                        ws.close(1008, 'Rate limit exceeded');
                        return;
                    }
                    return; // Drop the message silently
                }

                // Check message size
                const msgSize = typeof raw === 'string' ? raw.length : raw.byteLength || 0;
                if (msgSize > WS_MAX_MSG_SIZE) {
                    violations++;
                    logSecurityEvent('WS_OVERSIZE', wsIp,
                        `WebSocket message too large: ${(msgSize / 1024).toFixed(0)}KB (max ${WS_MAX_MSG_SIZE / 1024}KB)`,
                        'warn'
                    );

                    if (violations >= WS_MAX_VIOLATIONS) {
                        ws.close(1009, 'Message too large');
                        return;
                    }
                    return; // Drop oversized message
                }

                // All checks passed — call the original handler
                handler(raw);
            });
        }

        // For non-message events, pass through normally
        return originalOn(event, handler);
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// EXPORTS SUMMARY
// ════════════════════════════════════════════════════════════════════════════════
// Middleware (for app.use()):
//   autoban         — Layer 6: Check ban list (fastest rejection path)
//   sanitize        — Layer 3: SQL injection + XSS stripping
//   anomalyDetect   — Layer 1: Credential stuffing + wallet enumeration detection
//   bruteForceGuard — Layer 4: Failed auth tracking (use before requireWeb3Auth)
//
// Functions:
//   guardWebSocket(ws) — Layer 2: WS rate limiting + size validation
//   logSecurityEvent() — Layer 5: Log to console + PostgreSQL
// ════════════════════════════════════════════════════════════════════════════════
