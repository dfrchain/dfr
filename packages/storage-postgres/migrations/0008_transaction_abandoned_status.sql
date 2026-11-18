-- DFR ADR-037: transactions gain a terminal state `abandoned` (an explicitly voided unbroadcast transaction)
--
-- Background: `build` immediately occupies an on-chain nonce; when the caller decides not to submit, it must be able to explicitly void the transaction,
-- or the nonce stays occupied forever and a permanent gap forms on-chain (ADR-037).
--
-- Why this migration is needed: `0001` **hardcoded** the allowed set of `transactions.status` values in
-- the `transactions_status_check` CHECK constraint. When the application layer adds a state without updating the constraint,
-- writes fail with `violates check constraint "transactions_status_check"` —
-- which is exactly how the real integration run on 2026-10-07 caught it (the Abandoned migration had missed this change).
--
-- Forward migration: only rebuilds this one CHECK; no data changes, no other columns or indexes touched.
-- The single source of truth for staying consistent with `packages/types`' `TransactionStatus` is
-- chapter 3 of `docs/architecture/transaction-lifecycle.md`.

ALTER TABLE transaction_data.transactions
  DROP CONSTRAINT IF EXISTS transactions_status_check;

ALTER TABLE transaction_data.transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('built','simulated','signed','broadcast','pending','included',
                    'confirmed','finalized','failed','reverted','dropped','replaced','unknown',
                    -- ADR-037: reachable only from built/simulated; signed and above never enter.
                    'abandoned'));
