BEGIN;

CREATE INDEX IF NOT EXISTS chatgpt_projects_snapshot_idx
  ON chatgpt_projects(last_snapshot_id);
CREATE INDEX IF NOT EXISTS chatgpt_conversations_snapshot_idx
  ON chatgpt_conversations(last_snapshot_id);
CREATE INDEX IF NOT EXISTS chatgpt_sources_snapshot_idx
  ON chatgpt_sources(last_snapshot_id);

COMMIT;
