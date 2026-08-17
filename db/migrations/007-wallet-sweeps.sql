-- 007-wallet-sweeps.sql — durable evidence and history for cold sweeps.
BEGIN;

CREATE TABLE IF NOT EXISTS wallet_sweeps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state           text NOT NULL,
  cold_address    text NOT NULL,
  amount_shannons numeric(39,0) NOT NULL CHECK (amount_shannons > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  built_at        timestamptz,
  broadcast_at    timestamptz,
  confirmed_at    timestamptz,
  tx_hash         text UNIQUE,
  raw_tx_or_ref   text,
  fee_shannons    numeric(39,0),
  error           text
);

CREATE INDEX IF NOT EXISTS wallet_sweeps_unresolved_idx
  ON wallet_sweeps(created_at) WHERE state IN ('BUILT', 'BROADCAST');

COMMIT;

