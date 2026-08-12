-- 002-block-verification.sql — self-contained candidate verification.
BEGIN;

ALTER TABLE blocks ADD COLUMN IF NOT EXISTS template_json jsonb;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS block_epoch_json text;

COMMIT;
