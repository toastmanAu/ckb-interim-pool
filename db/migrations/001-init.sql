-- 001-init.sql — interim pool schema (spec 05 §2)
-- Money: NUMERIC(39,0) shannons, never REAL/DOUBLE. Work: NUMERIC(78,0).
-- Idempotency: unique constraints at every replay boundary.

BEGIN;

-- ── edges / boots ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS edges (
  id              text PRIMARY KEY,
  region          text NOT NULL DEFAULT '',
  name            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'unknown',
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  software_version text
);

CREATE TABLE IF NOT EXISTS edge_boots (
  boot_id     uuid PRIMARY KEY,
  edge_id     text NOT NULL REFERENCES edges(id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  version     text
);
CREATE INDEX IF NOT EXISTS edge_boots_edge_idx ON edge_boots(edge_id);

-- ── miners / workers / sessions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS miners (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_address  text NOT NULL UNIQUE,
  lock_hash       text,
  network         text NOT NULL DEFAULT 'ckb',
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  miner_id     uuid NOT NULL REFERENCES miners(id),
  worker_name  text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(miner_id, worker_name)
);

CREATE TABLE IF NOT EXISTS sessions (
  id              uuid PRIMARY KEY,
  edge_id         text NOT NULL,
  boot_id         uuid NOT NULL,
  worker_id       uuid REFERENCES workers(id),
  miner_family    text NOT NULL DEFAULT '',
  connected_at    timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  last_share_at   timestamptz,
  final_accepts   bigint NOT NULL DEFAULT 0,
  final_rejects   bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_edge_idx ON sessions(edge_id, boot_id);

-- ── share events (immutable accepted shares) ────────────────────────────────
CREATE TABLE IF NOT EXISTS share_events (
  id              uuid PRIMARY KEY,             -- event_id
  edge_id         text NOT NULL,
  boot_id         uuid NOT NULL,
  edge_seq        bigint NOT NULL,
  session_id      uuid NOT NULL,
  miner_id        uuid NOT NULL REFERENCES miners(id),
  worker_id       uuid NOT NULL REFERENCES workers(id),
  job_id          text NOT NULL,
  template_work_id text NOT NULL,
  work_units      numeric(78,0) NOT NULL,
  assigned_target text NOT NULL,
  pow_hash        text NOT NULL,
  nonce           text NOT NULL,
  hash            text NOT NULL,
  accepted_at     timestamptz NOT NULL,
  is_block_candidate boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(edge_id, boot_id, edge_seq),                     -- replay dedup
  UNIQUE(edge_id, boot_id, session_id, job_id, nonce)     -- double-submit dedup
);
CREATE INDEX IF NOT EXISTS share_events_accepted_idx ON share_events(accepted_at DESC);
CREATE INDEX IF NOT EXISTS share_events_miner_idx ON share_events(miner_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS share_events_worker_idx ON share_events(worker_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS share_events_work_idx ON share_events(accepted_at, work_units DESC);

-- ── configuration snapshots ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  active_from     timestamptz NOT NULL DEFAULT now(),
  pplns_window_num bigint NOT NULL,
  pplns_window_den bigint NOT NULL,
  fee_bps         integer NOT NULL,
  work_encoding_version integer NOT NULL DEFAULT 1,
  payout_policy_version integer NOT NULL DEFAULT 1,
  config_json     jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_hash     text NOT NULL UNIQUE
);

-- ── blocks ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blocks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_event_id uuid UNIQUE,             -- share event that won
  edge_id           text NOT NULL,
  boot_id           uuid NOT NULL,
  job_id            text NOT NULL,
  nonce             text NOT NULL,
  miner_id          uuid REFERENCES miners(id),
  worker_id         uuid REFERENCES workers(id),
  height            bigint,
  parent_hash       text,
  block_hash        text UNIQUE,
  state             text NOT NULL DEFAULT 'CANDIDATE',
  node_submit_result jsonb,
  found_at          timestamptz,
  node_accepted_at  timestamptz,
  matured_at        timestamptz,
  orphaned_at       timestamptz,
  reward_shannons   numeric(39,0),
  config_snapshot_id uuid REFERENCES config_snapshots(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(edge_id, boot_id, job_id, nonce)
);
CREATE INDEX IF NOT EXISTS blocks_state_idx ON blocks(state);
CREATE INDEX IF NOT EXISTS blocks_height_idx ON blocks(height);
CREATE INDEX IF NOT EXISTS blocks_orphan_check_idx ON blocks(block_hash) WHERE block_hash IS NOT NULL;

-- ── PPLNS allocations (immutable once ALLOCATED) ────────────────────────────
CREATE TABLE IF NOT EXISTS block_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id              uuid NOT NULL UNIQUE REFERENCES blocks(id),
  start_share_id        uuid REFERENCES share_events(id),
  end_share_id          uuid REFERENCES share_events(id),
  total_work            numeric(78,0) NOT NULL,
  distributable_shannons numeric(39,0) NOT NULL,
  pool_fee_shannons     numeric(39,0) NOT NULL,
  rounding_shannons     numeric(39,0) NOT NULL DEFAULT 0,
  allocation_hash       text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS block_allocation_items (
  allocation_id   uuid NOT NULL REFERENCES block_allocations(id),
  miner_id        uuid NOT NULL REFERENCES miners(id),
  work_units      numeric(78,0) NOT NULL,
  credit_shannons numeric(39,0) NOT NULL,
  PRIMARY KEY (allocation_id, miner_id)
);

-- ── immutable ledger ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type    text NOT NULL,
  miner_id        uuid REFERENCES miners(id),
  amount_shannons numeric(39,0) NOT NULL,      -- signed
  reference_type  text NOT NULL,
  reference_id    text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_miner_idx ON ledger_entries(miner_id, created_at);
CREATE INDEX IF NOT EXISTS ledger_ref_idx ON ledger_entries(reference_type, reference_id);

-- ── payouts ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payout_batches (
  id              uuid PRIMARY KEY,
  state           text NOT NULL DEFAULT 'CREATED',
  created_at      timestamptz NOT NULL DEFAULT now(),
  built_at        timestamptz,
  broadcast_at    timestamptz,
  confirmed_at    timestamptz,
  tx_hash         text UNIQUE,
  raw_tx_or_ref   text,
  fee_shannons    numeric(39,0),
  error           text
);
CREATE INDEX IF NOT EXISTS payout_batches_state_idx ON payout_batches(state);

CREATE TABLE IF NOT EXISTS payout_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        uuid NOT NULL REFERENCES payout_batches(id),
  miner_id        uuid NOT NULL REFERENCES miners(id),
  amount_shannons numeric(39,0) NOT NULL,
  state           text NOT NULL DEFAULT 'RESERVED',
  UNIQUE(batch_id, miner_id)
);
CREATE INDEX IF NOT EXISTS payout_items_state_idx ON payout_items(state);

-- ── universal event ingestion registry ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingested_events (
  event_id     uuid PRIMARY KEY,
  schema       text NOT NULL,
  edge_id      text NOT NULL,
  boot_id      uuid NOT NULL,
  edge_seq     bigint NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload_hash text NOT NULL,
  UNIQUE(edge_id, boot_id, edge_seq)
);
CREATE INDEX IF NOT EXISTS ingested_events_edge_idx ON ingested_events(edge_id, boot_id, edge_seq);

COMMIT;
