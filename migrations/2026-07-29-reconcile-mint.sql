-- ════════════════════════════════════════════════════════════════════
-- LEDGER RECONCILIATION PLAN
-- generated : 2026-07-29T18:21:12.358Z
-- api       : https://datachain-backend-production.up.railway.app
-- remedy    : MINT (balances are truth; no balance changes)
--
-- READ THIS BEFORE RUNNING:
--   1. Take a database backup. This edits the authoritative ledger.
--   2. Run inside the BEGIN/COMMIT below so a partial apply cannot happen.
--   3. Restart the API afterwards: state.loadSnapshot() reads state_balances
--      on boot, so a running process still holds the OLD numbers in memory
--      and would write them back over these on its next snapshot.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SYR — UNCONSERVED (phantom supply), net 70,299.999998 ──
--    Drift does NOT sum to zero: supply is OVERSTATED by 70,299.999998 SYR.

--    MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5z7IyY
--      stored 6,000,144,914.486614  |  from transactions 6,000,123,914.486614  |  drift 21,000
--      -> record the missing credit; balance unchanged
INSERT INTO transactions
    (block_index, from_address, to_address, amount, amount_usd, price_usd, type,
     token_symbol, timestamp_ms, is_system_generated, signature, public_key,
     platform_type, description)
VALUES
    (NULL, 'system', 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5z7IyY',
     21000, 0, 0, 'MINT', 'SYR', 1785349272357, TRUE, '', '', '',
     'Ledger reconciliation: records credit of 21,000 SYR present in state_balances but absent from the transaction log');

--    MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcZsKwt
--      stored 5,959,975,490.97878  |  from transactions 5,959,927,890.978782  |  drift 47,599.999998
--      -> record the missing credit; balance unchanged
INSERT INTO transactions
    (block_index, from_address, to_address, amount, amount_usd, price_usd, type,
     token_symbol, timestamp_ms, is_system_generated, signature, public_key,
     platform_type, description)
VALUES
    (NULL, 'system', 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcZsKwt',
     47599.99999809265, 0, 0, 'MINT', 'SYR', 1785349272357, TRUE, '', '', '',
     'Ledger reconciliation: records credit of 47,599.999998 SYR present in state_balances but absent from the transaction log');

--    nexus-system-miner
--      stored 18,600  |  from transactions 16,900  |  drift 1,700
--      -> record the missing credit; balance unchanged
INSERT INTO transactions
    (block_index, from_address, to_address, amount, amount_usd, price_usd, type,
     token_symbol, timestamp_ms, is_system_generated, signature, public_key,
     platform_type, description)
VALUES
    (NULL, 'system', 'nexus-system-miner',
     1700, 0, 0, 'MINT', 'SYR', 1785349272357, TRUE, '', '', '',
     'Ledger reconciliation: records credit of 1,700 SYR present in state_balances but absent from the transaction log');

-- ── GAMECASH — CONSERVED (misattribution), net -0 ──
--    Drift sums to zero: value was misattributed, not created. Totals stay intact.

--    MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5z7IyY
--      stored 470,560  |  from transactions 477,801.200942  |  drift -7,241.200942
--      -> record the missing debit; balance unchanged
INSERT INTO transactions
    (block_index, from_address, to_address, amount, amount_usd, price_usd, type,
     token_symbol, timestamp_ms, is_system_generated, signature, public_key,
     platform_type, description)
VALUES
    (NULL, 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5z7IyY', 'system',
     7241.20094179007, 0, 0, 'TRANSFER', 'GAMECASH', 1785349272357, TRUE, '', '', '',
     'Ledger reconciliation: records debit of 7,241.200942 GAMECASH present in state_balances but absent from the transaction log');

--    MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcZsKwt
--      stored 79,949.866488  |  from transactions 72,709.866488  |  drift 7,240
--      -> record the missing credit; balance unchanged
INSERT INTO transactions
    (block_index, from_address, to_address, amount, amount_usd, price_usd, type,
     token_symbol, timestamp_ms, is_system_generated, signature, public_key,
     platform_type, description)
VALUES
    (NULL, 'system', 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcZsKwt',
     7240, 0, 0, 'MINT', 'GAMECASH', 1785349272357, TRUE, '', '', '',
     'Ledger reconciliation: records credit of 7,240 GAMECASH present in state_balances but absent from the transaction log');

--    B7204
--      stored 176.354912  |  from transactions 175.15397  |  drift 1.200942
--      -> record the missing credit; balance unchanged
INSERT INTO transactions
    (block_index, from_address, to_address, amount, amount_usd, price_usd, type,
     token_symbol, timestamp_ms, is_system_generated, signature, public_key,
     platform_type, description)
VALUES
    (NULL, 'system', 'B7204',
     1.20094179000003, 0, 0, 'MINT', 'GAMECASH', 1785349272357, TRUE, '', '', '',
     'Ledger reconciliation: records credit of 1.200942 GAMECASH present in state_balances but absent from the transaction log');

-- Verify BEFORE committing. Re-run the audit in another shell if you want:
--     node tools/reconcile-ledger.js --all-tokens
-- If anything looks wrong: ROLLBACK;
COMMIT;
