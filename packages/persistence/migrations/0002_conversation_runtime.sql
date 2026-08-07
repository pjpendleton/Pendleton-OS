BEGIN;
CREATE TABLE IF NOT EXISTS conversation_sessions (
  session_id UUID PRIMARY KEY,
  contract_version TEXT NOT NULL CHECK (contract_version = '1.0.0'),
  principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('voice', 'mobile', 'web')),
  driving_mode BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
  started_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS conversation_sessions_resume_idx
  ON conversation_sessions(principal_id, project_id, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS conversation_turns (
  turn_sequence BIGSERIAL PRIMARY KEY,
  turn_id UUID UNIQUE NOT NULL,
  session_id UUID NOT NULL REFERENCES conversation_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'action_proposal', 'action_result', 'summary')),
  text TEXT NOT NULL CHECK (length(btrim(text)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) >= 8),
  command_id UUID,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS conversation_turns_session_idx
  ON conversation_turns(session_id, turn_sequence);

REVOKE ALL ON conversation_sessions, conversation_turns FROM anon, authenticated;
REVOKE ALL ON SEQUENCE conversation_turns_turn_sequence_seq FROM anon, authenticated;
COMMIT;
