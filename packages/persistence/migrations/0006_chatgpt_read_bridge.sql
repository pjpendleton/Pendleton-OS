BEGIN;

CREATE TABLE IF NOT EXISTS chatgpt_inventory_snapshots (
  snapshot_id TEXT PRIMARY KEY CHECK (length(btrim(snapshot_id)) BETWEEN 1 AND 200),
  snapshot_key TEXT NOT NULL CHECK (length(btrim(snapshot_key)) BETWEEN 8 AND 200),
  scope TEXT NOT NULL CHECK (scope IN ('project-list', 'project-detail')),
  observed_collections JSONB NOT NULL CHECK (jsonb_typeof(observed_collections) = 'array'),
  collector_version TEXT NOT NULL CHECK (length(btrim(collector_version)) BETWEEN 1 AND 40),
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  workspace_label TEXT NOT NULL CHECK (length(btrim(workspace_label)) BETWEEN 1 AND 160),
  page_url TEXT NOT NULL CHECK (page_url ~ '^https://chatgpt\.com/'),
  project_count INTEGER NOT NULL CHECK (project_count BETWEEN 0 AND 250),
  conversation_count INTEGER NOT NULL CHECK (conversation_count BETWEEN 0 AND 5000),
  source_count INTEGER NOT NULL CHECK (source_count BETWEEN 0 AND 5000),
  UNIQUE (workspace_label, snapshot_key)
);

CREATE TABLE IF NOT EXISTS chatgpt_projects (
  workspace_label TEXT NOT NULL,
  source_project_key TEXT NOT NULL CHECK (length(btrim(source_project_key)) BETWEEN 8 AND 256),
  locator_kind TEXT NOT NULL CHECK (locator_kind IN ('provider-id', 'derived-name')),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  canonical_url TEXT CHECK (canonical_url IS NULL OR canonical_url ~ '^https://chatgpt\.com/'),
  modified_label TEXT CHECK (modified_label IS NULL OR length(modified_label) <= 100),
  collector_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stale')),
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_snapshot_id TEXT NOT NULL REFERENCES chatgpt_inventory_snapshots(snapshot_id),
  PRIMARY KEY (workspace_label, source_project_key)
);
CREATE INDEX IF NOT EXISTS chatgpt_projects_status_idx
  ON chatgpt_projects(status, last_observed_at DESC);

CREATE TABLE IF NOT EXISTS chatgpt_conversations (
  workspace_label TEXT NOT NULL,
  source_project_key TEXT NOT NULL,
  source_conversation_key TEXT NOT NULL CHECK (length(btrim(source_conversation_key)) BETWEEN 8 AND 256),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  canonical_url TEXT CHECK (canonical_url IS NULL OR canonical_url ~ '^https://chatgpt\.com/'),
  modified_label TEXT CHECK (modified_label IS NULL OR length(modified_label) <= 100),
  status TEXT NOT NULL CHECK (status IN ('active', 'stale')),
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_snapshot_id TEXT NOT NULL REFERENCES chatgpt_inventory_snapshots(snapshot_id),
  PRIMARY KEY (workspace_label, source_project_key, source_conversation_key),
  FOREIGN KEY (workspace_label, source_project_key)
    REFERENCES chatgpt_projects(workspace_label, source_project_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chatgpt_conversations_project_idx
  ON chatgpt_conversations(workspace_label, source_project_key, status, last_observed_at DESC);

CREATE TABLE IF NOT EXISTS chatgpt_sources (
  workspace_label TEXT NOT NULL,
  source_project_key TEXT NOT NULL,
  source_key TEXT NOT NULL CHECK (length(btrim(source_key)) BETWEEN 8 AND 256),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 300),
  media_type TEXT CHECK (media_type IS NULL OR length(media_type) <= 160),
  detail_label TEXT CHECK (detail_label IS NULL OR length(detail_label) <= 200),
  content_access TEXT NOT NULL CHECK (content_access IN ('available', 'metadata-only', 'unknown')),
  status TEXT NOT NULL CHECK (status IN ('active', 'stale')),
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_snapshot_id TEXT NOT NULL REFERENCES chatgpt_inventory_snapshots(snapshot_id),
  PRIMARY KEY (workspace_label, source_project_key, source_key),
  FOREIGN KEY (workspace_label, source_project_key)
    REFERENCES chatgpt_projects(workspace_label, source_project_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chatgpt_sources_project_idx
  ON chatgpt_sources(workspace_label, source_project_key, status, last_observed_at DESC);

ALTER TABLE chatgpt_inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatgpt_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatgpt_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatgpt_sources ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON TABLE
  chatgpt_inventory_snapshots, chatgpt_projects, chatgpt_conversations, chatgpt_sources
  TO pendleton_runtime;

CREATE POLICY pendleton_runtime_access ON chatgpt_inventory_snapshots
  FOR ALL TO pendleton_runtime USING (true) WITH CHECK (true);
CREATE POLICY pendleton_runtime_access ON chatgpt_projects
  FOR ALL TO pendleton_runtime USING (true) WITH CHECK (true);
CREATE POLICY pendleton_runtime_access ON chatgpt_conversations
  FOR ALL TO pendleton_runtime USING (true) WITH CHECK (true);
CREATE POLICY pendleton_runtime_access ON chatgpt_sources
  FOR ALL TO pendleton_runtime USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE
  chatgpt_inventory_snapshots, chatgpt_projects, chatgpt_conversations, chatgpt_sources
  FROM anon, authenticated;

COMMIT;
