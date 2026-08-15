-- db/migrations/003-treasury.sql — treasury income reconciliation.
--
-- A CKB cellbase in block N pays the miner of block N-11. Recording what the
-- pool ACTUALLY received (rather than reading its own block's cellbase, which
-- pays a stranger) is what makes solvency checkable.
BEGIN;

CREATE TABLE IF NOT EXISTS treasury_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id             uuid NOT NULL UNIQUE REFERENCES blocks(id),
  block_height         bigint NOT NULL,
  payout_block_height  bigint NOT NULL,
  payout_tx_hash       text   NOT NULL,
  output_index         integer NOT NULL,
  lock_args            text   NOT NULL,
  amount_shannons      numeric(39,0) NOT NULL CHECK (amount_shannons >= 0),
  mature_at_epoch      bigint NOT NULL,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz,
  voided_at            timestamptz,
  UNIQUE (payout_tx_hash, output_index)
);
CREATE INDEX IF NOT EXISTS treasury_receipts_height_idx ON treasury_receipts(block_height);
CREATE INDEX IF NOT EXISTS treasury_receipts_conf_idx
  ON treasury_receipts(confirmed_at) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS treasury_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taken_at            timestamptz NOT NULL DEFAULT now(),
  lock_args           text NOT NULL,
  total_shannons      numeric(39,0) NOT NULL,
  spendable_shannons  numeric(39,0) NOT NULL,
  cell_count          integer NOT NULL,
  owed_shannons       numeric(39,0) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS treasury_snapshots_taken_idx ON treasury_snapshots(taken_at);

-- single-row: the cold sweep address, trusted on first use (Plan 2 uses it)
CREATE TABLE IF NOT EXISTS wallet_config (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cold_address  text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  approved_by   text,
  approved_at   timestamptz
);

ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS released_by text;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS released_at timestamptz;

COMMIT;
