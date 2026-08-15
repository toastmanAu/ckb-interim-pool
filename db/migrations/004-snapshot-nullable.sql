-- 004-snapshot-nullable.sql — spendable_shannons/cell_count are not yet measured.
--
-- Both columns are measured by enumerating the treasury lock's cells through
-- an indexer, which Plan 1 does not have (that arrives in a later plan). A
-- stored 0 would assert "nothing is spendable" — indistinguishable from a
-- real zero forever after. NULL means not-yet-measured; write NULL, not 0.
BEGIN;

ALTER TABLE treasury_snapshots ALTER COLUMN spendable_shannons DROP NOT NULL;
ALTER TABLE treasury_snapshots ALTER COLUMN cell_count         DROP NOT NULL;

COMMIT;
