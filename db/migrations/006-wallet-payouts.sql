-- 006-wallet-payouts.sql — approval bookkeeping for capped autonomy.
--
-- HELD is not an error. It parks a correct batch that exceeds the wallet's
-- unattended limits until an operator releases it. The release identity and
-- time are durable audit data; held_reason explains why approval was needed.
BEGIN;

ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS released_by text;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS released_at timestamptz;
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS held_reason text;

CREATE INDEX IF NOT EXISTS payout_batches_held_idx
  ON payout_batches(created_at) WHERE state = 'HELD';

COMMIT;
