BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY CHECK (project_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'test', 'staging', 'production')),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS project_aliases (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  alias TEXT NOT NULL CHECK (length(btrim(alias)) BETWEEN 1 AND 160),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, alias)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_aliases_normalized_idx
  ON project_aliases(project_id, lower(btrim(alias)));
CREATE INDEX IF NOT EXISTS project_aliases_lookup_idx
  ON project_aliases(lower(btrim(alias)));

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  actor_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, actor_id)
);

CREATE TABLE IF NOT EXISTS project_resources (
  resource_id TEXT PRIMARY KEY CHECK (length(btrim(resource_id)) BETWEEN 1 AND 200),
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google-drive', 'local-filesystem', 'gmail', 'microsoft-graph', 'manual')),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('project-root', 'folder', 'document', 'mailbox', 'repository', 'other')),
  external_id TEXT NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 2048),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  canonical_url TEXT CHECK (canonical_url IS NULL OR canonical_url ~ '^https://'),
  status TEXT NOT NULL CHECK (status IN ('active', 'disconnected')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  discovered_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, provider, resource_type, external_id)
);
CREATE INDEX IF NOT EXISTS project_resources_project_idx
  ON project_resources(project_id, provider, resource_type, status);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_resources ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON TABLE
  projects, project_aliases, project_members, project_resources
  TO pendleton_runtime;

CREATE POLICY pendleton_runtime_access ON projects
  FOR ALL TO pendleton_runtime USING (true) WITH CHECK (true);
CREATE POLICY pendleton_runtime_access ON project_aliases
  FOR ALL TO pendleton_runtime USING (true) WITH CHECK (true);
CREATE POLICY pendleton_runtime_access ON project_members
  FOR ALL TO pendleton_runtime USING (true) WITH CHECK (true);
CREATE POLICY pendleton_runtime_access ON project_resources
  FOR ALL TO pendleton_runtime USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE
  projects, project_aliases, project_members, project_resources
  FROM anon, authenticated;

INSERT INTO projects
  (project_id,display_name,description,environment,status,created_at,updated_at)
VALUES
  ('pendleton-os','Pendleton OS','Executive operating system and governed automation platform.','production','active',now(),now())
ON CONFLICT (project_id) DO UPDATE
SET display_name=EXCLUDED.display_name,
    description=EXCLUDED.description,
    environment=EXCLUDED.environment,
    status='active',
    updated_at=EXCLUDED.updated_at;

INSERT INTO project_aliases (project_id,alias,created_at)
VALUES
  ('pendleton-os','Pendleton OS',now()),
  ('pendleton-os','os',now())
ON CONFLICT DO NOTHING;

INSERT INTO project_members (project_id,actor_id,role,status,created_at,updated_at)
VALUES
  ('pendleton-os','018f1f91-6f3d-7c16-bc61-55f9fa334f12','owner','active',now(),now())
ON CONFLICT (project_id,actor_id) DO UPDATE
SET role='owner',status='active',updated_at=EXCLUDED.updated_at;

INSERT INTO project_resources
  (resource_id,project_id,provider,resource_type,external_id,display_name,canonical_url,status,metadata,discovered_at,updated_at)
VALUES
  ('drive:pendleton-os-root','pendleton-os','google-drive','project-root',
   '10IWtfsRSvgiUuN1CrE3nZvFW2XXRRS49','Pendleton-OS Google Drive folder',
   'https://drive.google.com/drive/folders/10IWtfsRSvgiUuN1CrE3nZvFW2XXRRS49',
   'active','{"source":"existing-production-configuration"}'::jsonb,now(),now())
ON CONFLICT (project_id,provider,resource_type,external_id) DO UPDATE
SET display_name=EXCLUDED.display_name,
    canonical_url=EXCLUDED.canonical_url,
    status='active',
    metadata=EXCLUDED.metadata,
    updated_at=EXCLUDED.updated_at;

COMMIT;
