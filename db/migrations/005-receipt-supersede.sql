-- 005-receipt-supersede.sql — a voided receipt must not be terminal.
--
-- A receipt is voided when block H+11's cellbase tx hash changes before the
-- receipt confirms. An ordinary 1-block reorg at H+11 ALWAYS changes that
-- hash, even when the new H+11 still pays the pool correctly — so voiding is
-- routine, not exotic. With UNIQUE(block_id) at table level no replacement row
-- could ever be inserted, `voided_at` is never cleared, and
-- allocator.rewardForBlock requires a confirmed un-voided receipt: one reorg
-- stranded a real reward permanently, recoverable only by a manual DELETE.
--
-- Both unique keys become PARTIAL, over live (un-voided) rows only:
--   * (block_id)                     — one live receipt per block, as before;
--   * (payout_tx_hash, output_index) — one live claim per cellbase output, as
--     before. Partial as well, so a chain that reorgs BACK to the original
--     H+11 can re-record the original output instead of being blocked by the
--     voided row that already holds it.
-- The voided rows stay, as the history of what was seen and withdrawn.
BEGIN;

ALTER TABLE treasury_receipts DROP CONSTRAINT IF EXISTS treasury_receipts_block_id_key;
ALTER TABLE treasury_receipts
  DROP CONSTRAINT IF EXISTS treasury_receipts_payout_tx_hash_output_index_key;

CREATE UNIQUE INDEX IF NOT EXISTS treasury_receipts_live_block_idx
  ON treasury_receipts (block_id) WHERE voided_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS treasury_receipts_live_output_idx
  ON treasury_receipts (payout_tx_hash, output_index) WHERE voided_at IS NULL;

COMMIT;
