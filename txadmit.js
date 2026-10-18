// ════════════════════════════════════════════════════════════════════════════════
// txadmit.js — may this node CARRY a signed transaction? The pure checks every door into a
//              mempool shares (Step 3, 2026-10-18: the relay of browser-signed transactions).
//
// ⚠️ CONSENSUS CODE IN TWO COPIES. Exe/core/txadmit.js is the CommonJS twin of this file. It is
// LOCAL POLICY, not a block rule, but both nodes must give the SAME verdict on the same
// transaction, or a transaction one node relays the other drops for a reason nobody can see.
// Exe/tests/module-parity.test.mjs drives both copies. Change both or neither.
//
// Used by: Exe/core/tx-intake.js (website relay, local /tx/new, peer gossip) and this node's
// api.js POST /api/tx/submit + mempool.addSignedTransaction. Rate limits and storage stay with
// each node; everything here is a function of the transaction and what the caller hands in.
//
// THE CHECKS, IN ORDER (the first failure is the verdict):
//   admitStatic   1 shape   a plain object, at most MAX_TX_BYTES, signed, not a system claim,
//                           not spending from an address nobody holds a key for
//                 2 hash    `hash` = sha256 of the body it was set on (every wallet here sets it
//                           BEFORE signing), so "same hash" means "same transaction"
//                 3 fresh   relay: within 10 min of this clock; peer: at most 2 h old; never
//                           more than the block rule's 2 h ahead
//                 4 rules   txrules.checkUserTx at the next height (signature, key ownership,
//                           escrow book, key registration — what a block is judged by)
//                 5 replay  already mined (ctx.seen)
//   admitFunds    6 deploy  a named product, a valid ticker nobody holds yet, a real fee ($1.00 in
//                           SYR at this node's price; not judged for peers' deploys)
//                 7 ledger  the ledger's own check (strictCheck)
//                 8 queue   at most MAX_PENDING_PER_ADDRESS waiting per sender (not local);
//                           one escrow close / one key registration waiting at a time
//                 9 funds   what the sender already has WAITING is counted, so queued spends can
//                           never exceed the balance
//                10 website a DelChain deploy's website proven on THIS node (not for peers: they
//                           were checked where they were made)
// ════════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { RULES_DEFAULTS, KEYLESS, checkUserTx, txId } from './txrules.js';
import { toUnits, fromUnits, priceE18 } from './dex.js';

export const ADMIT_LIMITS = Object.freeze({
    MAX_BYTES: RULES_DEFAULTS.MAX_TX_BYTES,
    RELAY_SKEW_MS: 10 * 60 * 1000,          // a phone's clock may be off by a few minutes
    PEER_MAX_AGE_MS: 2 * 60 * 60 * 1000,
    FUTURE_MS: RULES_DEFAULTS.MAX_FUTURE_MS,
    MAX_PENDING_PER_ADDRESS: 25,
    OPENCHAIN_FEE_SDX: 1                     // state.js / state-db.js OPENCHAIN_PLATFORM_FEE_SDX
});

export const ADMIT_SOURCES = ['relay', 'local', 'peer'];

// What a deploy must look like to be carried (the local deploy routes' own preflight, local-api.js).
export const DEPLOY_RULES = Object.freeze({
    TICKER: /^[A-Z][A-Z0-9]{1,11}$/,
    RESERVED: Object.freeze(['SYR', 'USD', 'SDTX', 'SDX']),
    MAX_SUPPLY: 1e15,
    FEE_TOLERANCE: 0.95                     // the price may move a little between quote and submit
});

const refuse = (status, code, why) => ({ ok: false, status, code, why });

/** sha256 of the body the hash was computed from: everything but the hash and the signatures. */
export function bodyHash(tx) {
    const { hash, signature, publicKey, uid, ...body } = tx;            // eslint-disable-line no-unused-vars
    if (tx.type === 'KEY_REGISTER') delete body.ownerSignature;         // added after hashing (key-record.js)
    return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * What a transaction takes out of its sender's balance once applied, as [token, amount] pairs.
 * Mirrors the ledger checks (state.js / state-db strictCheck): value types debit their coin, a
 * deploy its fee; escrow closes debit the escrow address and zero types move nothing.
 */
export function debitsOf(tx, { openchainFeeSdx = ADMIT_LIMITS.OPENCHAIN_FEE_SDX, rules2 = false } = {}) {
    const type = String((tx && tx.type) || 'TRANSFER');
    const token = (tx && tx.tokenSymbol) || 'SYR';
    const amt = Number(tx && tx.amount) || 0;
    if (type === 'TRANSFER' || type === 'ESCROW_LOCK' || type === 'LIQUIDITY_DEPOSIT' || type === 'VERIFIER_BOND' || type === 'SDTX_BURN') {
        return amt > 0 ? [[token, amt]] : [];
    }
    // On-chain trading (dex.js): what the signer pays in or locks. A pool seeded from a supply
    // address takes its tokens from THAT address, not the signer.
    if (type === 'SWAP') return amt > 0 ? [[tx.side === 'buy' ? 'SDTX' : token, amt]] : [];
    if (type === 'ORDER_PLACE') {
        if (tx.side !== 'buy') return amt > 0 ? [[token, amt]] : [];
        const P = priceE18(tx.price), q = amt > 0 ? toUnits(amt) : 0n, E18 = 1000000000000000000n;
        return P > 0n && q > 0n ? [['SDTX', fromUnits((q * P + E18 - 1n) / E18)]] : [];
    }
    if (type === 'POOL_CREATE' || type === 'POOL_ADD') {
        const out = [];
        if (amt > 0 && (tx.source === undefined || tx.source === tx.from)) out.push([token, amt]);
        if (Number(tx.sdtx) > 0) out.push(['SDTX', Number(tx.sdtx)]);
        return out;
    }
    if (type === 'TOKEN_DEPLOY') {
        const meta = (tx.token && typeof tx.token === 'object') ? tx.token : {};
        if (rules2) {                         // the block charges at most what the deploy allows
            if (String(meta.chain) === 'openchain') {
                const nf = Number(meta.maxNetworkFeeSyr) || 0;
                return nf > 0 ? [['SDTX', 1], ['SYR', nf]] : [['SDTX', 1]];
            }
            return Number(meta.maxFeeSyr) > 0 ? [['SYR', Number(meta.maxFeeSyr)]] : [];
        }
        if (String(meta.chain || '').toLowerCase() === 'openchain') {
            const out = [['SDX', openchainFeeSdx]];
            const nf = Number(meta.networkFeeSyr) || 0;
            if (nf > 0 && meta.networkFeeTo) out.push(['SYR', nf]);
            return out;
        }
        const fee = Number(meta.feeSyr) || 0;
        return fee > 0 ? [['SYR', fee]] : [];
    }
    return [];
}

/**
 * Checks 1-5: everything that depends only on the transaction, the clock and the chain.
 * @param {object} tx
 * @param {object} o
 * @param {string} [o.source]  'relay' | 'local' | 'peer'
 * @param {number} o.now       this node's clock (ms)
 * @param {number} o.height    the index of the next block
 * @param {object} o.ctx       txrules.ruleIndex(...).ctx() over the live chain
 * @param {object} [o.limits]  overrides of ADMIT_LIMITS (tests)
 * @returns {{ok:true, id:string} | {ok:false, status:number, code:string, why:string}}
 */
export function admitStatic(tx, { source = 'local', now, height, ctx = {}, limits = {} } = {}) {
    const L = Object.assign({}, ADMIT_LIMITS, limits);
    const src = ADMIT_SOURCES.includes(source) ? source : 'local';
    // 1. shape
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return refuse(400, 'not-a-transaction', 'not a transaction');
    let size = 0;
    try { size = JSON.stringify(tx).length; } catch (e) { return refuse(400, 'not-a-transaction', 'not serialisable'); }
    if (size > L.MAX_BYTES) return refuse(413, 'too-large', `too large (${size} bytes; at most ${L.MAX_BYTES})`);
    if (tx.isSystemGenerated) return refuse(400, 'system-claim', 'a signed transaction cannot claim to be system-generated');
    if (typeof tx.from !== 'string' || !tx.from) return refuse(400, 'not-a-transaction', 'missing "from"');
    if (tx.from.toLowerCase() === 'system' || KEYLESS.includes(tx.from)) return refuse(400, 'keyless', 'nothing can be spent from ' + tx.from);
    if (tx.to === 'nexus-dex-pool' || tx.to === 'nexus-dex-orders') return refuse(400, 'keyless', 'nothing can be sent to ' + tx.to + ' (it holds the markets)');
    if (typeof tx.signature !== 'string' || !tx.signature || typeof tx.publicKey !== 'string' || !tx.publicKey) {
        return refuse(400, 'unsigned', 'unsigned: a transaction needs its signature and public key');
    }
    // 2. hash
    if (typeof tx.hash !== 'string' || !/^[0-9a-f]{64}$/.test(tx.hash)) return refuse(400, 'bad-hash', 'missing or malformed "hash"');
    if (bodyHash(tx) !== tx.hash) return refuse(400, 'bad-hash', '"hash" does not match the transaction (set it before signing)');
    // 3. fresh
    const ts = Number(tx.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return refuse(400, 'stale', 'missing timestamp');
    if (ts > now + (src === 'relay' ? L.RELAY_SKEW_MS : L.FUTURE_MS)) return refuse(400, 'future', 'dated in the future (check the device clock)');
    if (src === 'relay' && ts < now - L.RELAY_SKEW_MS) {
        return refuse(400, 'stale', 'too old: sign it again (a relayed transaction must be under 10 minutes old)');
    }
    if (src === 'peer' && ts < now - L.PEER_MAX_AGE_MS) return refuse(400, 'stale', 'too old to relay');
    // 4. rules
    const why = checkUserTx(tx, { timestamp: now, index: height }, ctx);
    if (why) return refuse(400, 'refused', why);
    // 5. replay
    const id = txId(tx);
    let mined = false;
    try { mined = typeof ctx.seen === 'function' && !!ctx.seen(id); } catch (e) { mined = false; }
    if (mined) return refuse(409, 'replay', 'already mined in an earlier block');
    return { ok: true, id };
}

/**
 * Checks 6-8: the sender's funds against the ledger and what is already waiting.
 * @param {object} tx         a transaction admitStatic accepted
 * @param {object} o
 * @param {string} [o.source]
 * @param {(tx:object) => (string|null)} [o.strictCheck]   the ledger's own refusal, or null
 * @param {(address:string, token:string) => number} o.balanceOf
 * @param {Array<object>} [o.waiting]                      the transactions waiting from tx.from
 * @param {(address:string, domain:string) => boolean} [o.isDomainVerified]
 * @param {(ticker:string) => boolean} [o.tokenExists]      a registry row or any holder (deploys are refused without it)
 * @param {boolean} [o.rules2]                              on-chain trading active at the next height
 * @param {() => number} [o.minDeployFeeSyr]               $1.00 in SYR at this node's price (0 = unknown)
 * @param {object} [o.limits]
 * @returns {{ok:true} | {ok:false, status:number, code:string, why:string}}
 */
export function admitFunds(tx, { source = 'local', strictCheck = null, balanceOf, waiting = [], isDomainVerified = null,
                                 tokenExists = null, minDeployFeeSyr = null, rules2 = false, limits = {} } = {}) {
    const L = Object.assign({}, ADMIT_LIMITS, limits);
    const src = ADMIT_SOURCES.includes(source) ? source : 'local';
    // 6. deploy. The block rules for tickers and fees arrive with RULES_2 (Step 4); until then
    //    BOTH ledgers credit a deploy's supply even when its ticker already exists: a deploy of
    //    "SYR" would mint SYR to its signer, at whatever fee the signer wrote. No node carries
    //    such a deploy, whoever sent it (found 2026-10-18 while building this relay).
    if (tx.type === 'TOKEN_DEPLOY') {
        const meta = (tx.token && typeof tx.token === 'object') ? tx.token : null;
        const product = meta ? String(meta.chain || '').toLowerCase() : '';
        if (product !== 'delchain' && product !== 'openchain') {
            return refuse(400, 'bad-deploy', 'a deploy names its product: token.chain is "delchain" or "openchain"');
        }
        const ticker = typeof tx.tokenSymbol === 'string' ? tx.tokenSymbol : '';
        if (!DEPLOY_RULES.TICKER.test(ticker)) return refuse(400, 'bad-deploy', 'a ticker is 2-12 capital letters and digits, starting with a letter');
        if (DEPLOY_RULES.RESERVED.includes(ticker)) return refuse(400, 'bad-deploy', ticker + ' is reserved');
        const supply = Number(tx.amount);
        if (!(supply > 0 && supply <= DEPLOY_RULES.MAX_SUPPLY)) return refuse(400, 'bad-deploy', 'the supply must be above 0 and at most 1,000,000,000,000,000');
        if (typeof tokenExists !== 'function') return refuse(503, 'not-ready', 'this node cannot check which tickers are taken');
        if (tokenExists(ticker)) return refuse(409, 'duplicate-ticker', ticker + ' already exists');
        if (product === 'delchain' && !rules2) {    // from RULES_2 the block computes the fee (deployShapeWhy: maxFeeSyr)
            const fee = Number(meta.feeSyr) || 0;
            if (!(fee > 0)) return refuse(400, 'bad-deploy', 'a DelChain deploy pays $1.00 in SYR (token.feeSyr)');
            if (src !== 'peer') {            // a peer's deploy was priced where it was made
                const min = typeof minDeployFeeSyr === 'function' ? Number(minDeployFeeSyr()) || 0 : 0;
                if (!(min > 0)) return refuse(503, 'no-price', 'this node does not know the SYR price yet, so the $1.00 fee cannot be checked');
                if (fee < min * DEPLOY_RULES.FEE_TOLERANCE) {
                    return refuse(400, 'fee-too-low', `the $1.00 fee is ${min} SYR at today's price; this deploy pays ${fee}`);
                }
            }
        }
    }
    // 7. ledger
    const floor = typeof strictCheck === 'function' ? strictCheck(tx) : null;
    if (floor) return refuse(400, /^insufficient/i.test(floor) ? 'insufficient' : 'ledger', floor);
    // 8. queue
    const list = Array.isArray(waiting) ? waiting : [];
    if (src !== 'local' && list.length >= L.MAX_PENDING_PER_ADDRESS) {
        return refuse(429, 'too-many-pending', `this address already has ${list.length} transactions waiting: let a block take some first`);
    }
    if (tx.type === 'ESCROW_RELEASE' || tx.type === 'ESCROW_REFUND') {
        if (list.some(w => (w.type === 'ESCROW_RELEASE' || w.type === 'ESCROW_REFUND') && w.escrowId === tx.escrowId)) {
            return refuse(409, 'duplicate', 'this escrow already has a release or refund waiting');
        }
    }
    if (tx.type === 'KEY_REGISTER' && list.some(w => w.type === 'KEY_REGISTER')) {
        return refuse(409, 'duplicate', 'a registration for this address is already waiting');
    }
    // 9. funds, counting what is already waiting
    const need = debitsOf(tx, { openchainFeeSdx: L.OPENCHAIN_FEE_SDX, rules2 });
    if (need.length) {
        const pending = {};
        for (const w of list) for (const [tok, a] of debitsOf(w, { openchainFeeSdx: L.OPENCHAIN_FEE_SDX, rules2 })) pending[tok] = (pending[tok] || 0) + a;
        for (const [tok, a] of need) {
            const have = Number((Number(balanceOf(tx.from, tok)) || 0).toFixed(8));
            const left = Number((have - (pending[tok] || 0)).toFixed(8));
            if (left < a) {
                return refuse(400, 'insufficient', `insufficient ${tok}: ${tx.from} holds ${have}, ${pending[tok] || 0} of it already ` +
                                                   `waiting to be spent, needs ${a} more`);
            }
        }
    }
    // 10. website: a DelChain deploy's, proven on THIS node
    if (tx.type === 'TOKEN_DEPLOY' && src !== 'peer') {
        const meta = (tx.token && typeof tx.token === 'object') ? tx.token : {};
        if (String(meta.chain || '').toLowerCase() === 'delchain') {
            const site = String(meta.website || '');
            const proven = !!site && typeof isDomainVerified === 'function' && !!isDomainVerified(tx.from, site);
            if (!proven) {
                return refuse(403, 'domain-unverified', site
                    ? `${site} is not verified for ${tx.from} on this node: add the TXT record _syrpts-verify.${site} ` +
                      `with the value datachain-verify=${tx.from}, verify it, then deploy`
                    : 'a DelChain token needs a verified website');
            }
        }
    }
    return { ok: true };
}
