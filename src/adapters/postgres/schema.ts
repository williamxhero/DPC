export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dpc_action_executions (
  execution_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision TEXT NOT NULL,
  action_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  nf_task_id TEXT NOT NULL,
  run_generation INTEGER NOT NULL,
  claim_fence INTEGER NOT NULL DEFAULT 0,
  lifecycle TEXT NOT NULL,
  action_json JSONB NOT NULL,
  current_receipt_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_id, plan_id, event_key),
  UNIQUE (program_id, plan_id, nf_task_id, run_generation)
);

CREATE INDEX IF NOT EXISTS dpc_action_executions_action_idx
  ON dpc_action_executions (program_id, plan_id, action_id, run_generation DESC);

CREATE TABLE IF NOT EXISTS dpc_action_receipts (
  receipt_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES dpc_action_executions(execution_id),
  program_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision TEXT NOT NULL,
  action_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  nf_task_id TEXT NOT NULL,
  run_generation INTEGER NOT NULL,
  claim_fence INTEGER NOT NULL,
  receipt_kind TEXT NOT NULL,
  nf_status TEXT NOT NULL,
  business_status TEXT NOT NULL,
  receipt_json JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dpc_action_receipts_execution_idx
  ON dpc_action_receipts (execution_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS dpc_claims (
  program_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  claim_fence INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  run_generation INTEGER NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, plan_id, action_id)
);

CREATE TABLE IF NOT EXISTS dpc_outbox_events (
  outbox_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dpc_outbox_ready_idx
  ON dpc_outbox_events (status, available_at);

CREATE TABLE IF NOT EXISTS dpc_wake_intents (
  wake_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  action_id TEXT,
  plan_revision TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  not_before TIMESTAMPTZ NOT NULL,
  preferred_harness TEXT,
  fallback_policy TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  claim_fence INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dpc_wake_ready_idx
  ON dpc_wake_intents (status, not_before);

CREATE TABLE IF NOT EXISTS dpc_handoff_bundles (
  handoff_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision TEXT NOT NULL,
  action_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  source_harness TEXT NOT NULL,
  source_run TEXT NOT NULL,
  status TEXT NOT NULL,
  bundle_json JSONB NOT NULL,
  accepted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  UNIQUE (program_id, plan_id, plan_revision, action_id, event_key, source_run)
);

CREATE TABLE IF NOT EXISTS dpc_inbox_events (
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  PRIMARY KEY (provider, external_event_id)
);

CREATE TABLE IF NOT EXISTS dpc_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
