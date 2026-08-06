BEGIN;
CREATE TABLE IF NOT EXISTS kernel_events (
  sequence_id BIGSERIAL PRIMARY KEY,
  event_id UUID UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id UUID NOT NULL,
  causation_id UUID,
  command_id UUID,
  workflow_id UUID,
  actor_id UUID,
  project_id TEXT,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS kernel_events_correlation_idx ON kernel_events(correlation_id, sequence_id);
CREATE INDEX IF NOT EXISTS kernel_events_command_idx ON kernel_events(command_id) WHERE command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kernel_events_workflow_idx ON kernel_events(workflow_id) WHERE workflow_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kernel_idempotency (
  actor_id UUID NOT NULL,
  project_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_id UUID NOT NULL,
  payload_hash TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, project_id, command_type, idempotency_key)
);

CREATE TABLE IF NOT EXISTS kernel_workflows (
  workflow_id UUID PRIMARY KEY,
  command_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
COMMIT;
