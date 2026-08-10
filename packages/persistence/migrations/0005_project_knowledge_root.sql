BEGIN;

INSERT INTO project_resources
  (resource_id,project_id,provider,resource_type,external_id,display_name,canonical_url,status,metadata,discovered_at,updated_at)
VALUES
  ('drive:pendleton-os-knowledge-root','pendleton-os','google-drive','folder',
   '1p4yRSAJYFc6h2k0hD-lLy0-xiG3CE8k8','Pendleton-OS project knowledge root',
   'https://drive.google.com/drive/folders/1p4yRSAJYFc6h2k0hD-lLy0-xiG3CE8k8',
   'active','{"access":"read-only","purpose":"project-knowledge","source":"verified-google-drive"}'::jsonb,
   now(),now())
ON CONFLICT (project_id,provider,resource_type,external_id) DO UPDATE
SET display_name=EXCLUDED.display_name,
    canonical_url=EXCLUDED.canonical_url,
    status='active',
    metadata=EXCLUDED.metadata,
    updated_at=EXCLUDED.updated_at;

COMMIT;
