/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/use-unknown-in-catch-callback-variable */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PostgresProjectRegistry, createPostgresPool } from '../packages/persistence/dist/index.js';

const roots = [
  { path: 'D:\\Projects', source: 'local-project-root' },
  { path: 'G:\\My Drive\\AI\\Projects', source: 'google-drive-desktop-sync' },
];
const excludedNames = new Set(['_ARCHIVE', '_SECRETS']);
const ownerActorId = process.env.PENDLETON_ACTOR_ID ?? '018f1f91-6f3d-7c16-bc61-55f9fa334f12';
const apply = process.argv.includes('--apply');

const slug = (value) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);

const resourceId = (path) =>
  `resource:local:${createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 24)}`;

const candidatesById = new Map();
for (const root of roots) {
  const entries = await readdir(root.path, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || excludedNames.has(entry.name))
      continue;
    const projectId = slug(entry.name);
    if (projectId.length === 0) continue;
    const path = join(root.path, entry.name);
    const current = candidatesById.get(projectId) ?? {
      projectId,
      displayName: entry.name,
      aliases: [],
      environment: 'production',
      resources: [],
    };
    current.aliases = [...new Set([...current.aliases, entry.name])];
    current.resources.push({
      resourceId: resourceId(path),
      provider: 'local-filesystem',
      resourceType: 'folder',
      externalId: path,
      displayName: `${entry.name} (${root.source})`,
      metadata: { access: 'desktop-only', source: root.source },
    });
    candidatesById.set(projectId, current);
  }
}

const candidates = [...candidatesById.values()].sort((left, right) =>
  left.projectId.localeCompare(right.projectId),
);
console.log(`PROJECT_CANDIDATES_DISCOVERED count=${candidates.length}`);
if (!apply) {
  console.log('PROJECT_IMPORT_DRY_RUN use=--apply');
  process.exit(0);
}

const databaseUrl = (
  process.env.DATABASE_URL ??
  (await readFile(
    join(homedir(), 'AppData', 'Local', 'PendletonOS', 'secrets', 'database-url.txt'),
    'utf8',
  ))
).trim();
const pool = createPostgresPool(databaseUrl);
try {
  const registry = new PostgresProjectRegistry(pool);
  const imported = await registry.importCandidates(candidates, ownerActorId);
  const active = imported.filter(({ status }) => status === 'active').length;
  const staged = imported.filter(({ status }) => status === 'candidate').length;
  console.log(
    `PROJECT_CANDIDATES_IMPORTED total=${imported.length} staged=${staged} active=${active}`,
  );
} finally {
  await pool.end();
}
