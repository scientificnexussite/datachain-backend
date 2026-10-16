/* ════════════════════════════════════════════════════════════════════════════════════════
   gov-record.js — the GOV_ROLE ledger record (D:\Decisions\Ai\11_GOVERNANCE_COUNCIL.txt §9B).

   ⚠️ CONSENSUS CODE IN TWO COPIES. Exe/core/gov-record.js is the CommonJS twin of this file;
   state.js accepts a GOV_ROLE only if isWellFormedGovRole says so, and so does the exe's
   state-db.js — a node that dropped one would build a DIFFERENT block (a fork).
   Exe/tests/module-parity.test.mjs drives both copies with the same cases. Change both or neither.

   The ledger checks only the SHAPE. Who may appoint whom, and whether the signature is genuine,
   is decided where the role list is rebuilt from blocks (Exe/core/gov-registry.js).
   ════════════════════════════════════════════════════════════════════════════════════════ */
import crypto from 'crypto';

export const GOV_ACTIONS = ['appoint', 'remove', 'ban'];
export const GOV_ROLES = ['ceo', 'manager', 'team'];
export const TEAM_POSTS = ['builder', 'tester', 'security', 'security_dean'];

export function canonicalSpki(key) {
    if (!key) return null;
    try {
        const s = String(key).trim();
        const obj = s.includes('-----BEGIN')
            ? crypto.createPublicKey(s)
            : crypto.createPublicKey({ key: Buffer.from(s.replace(/^nx_/, ''), 'base64'), format: 'der', type: 'spki' });
        if (obj.asymmetricKeyType !== 'ec' || (obj.asymmetricKeyDetails || {}).namedCurve !== 'prime256v1') return null;
        return obj.export({ type: 'spki', format: 'der' }).toString('base64');
    } catch (e) {
        return null;
    }
}

export function strongAddressOf(key) {
    const spki = canonicalSpki(key);
    if (!spki) return null;
    const pem = crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' })
        .export({ type: 'spki', format: 'pem' });
    return 'nx_' + crypto.createHash('sha256').update(pem).digest('hex').substring(0, 40);
}

export function isWellFormedGovRole(tx) {
    if (!tx || String(tx.type).toUpperCase() !== 'GOV_ROLE') return false;
    if (Number(tx.amount || 0) !== 0) return false;
    if (!GOV_ACTIONS.includes(tx.action)) return false;
    if (typeof tx.from !== 'string' || !/^nx_[0-9a-f]{40}$/.test(tx.from)) return false;
    if (typeof tx.targetKey !== 'string' || tx.targetKey.length < 80 || tx.targetKey.length > 200) return false;
    const target = canonicalSpki(tx.targetKey);
    if (!target || target !== tx.targetKey) return false;
    if (tx.to !== strongAddressOf(target)) return false;
    if (tx.action === 'appoint') {
        if (!GOV_ROLES.includes(tx.role)) return false;
        if (tx.role === 'team' ? !TEAM_POSTS.includes(tx.post) : (tx.post !== undefined && tx.post !== null)) return false;
    } else if (tx.role !== undefined && tx.role !== null) {
        return false;
    }
    if (tx.action === 'ban') {
        if (!Number.isInteger(tx.until) || tx.until < 0) return false;
    } else if (tx.until !== undefined && tx.until !== null) {
        return false;
    }
    if (typeof tx.nonce !== 'string' || !/^[0-9a-f]{16,64}$/.test(tx.nonce)) return false;
    return true;
}

export function signedBytes(tx) {
    const { signature, publicKey, uid, ...body } = tx;    // eslint-disable-line no-unused-vars
    return JSON.stringify(body);
}
