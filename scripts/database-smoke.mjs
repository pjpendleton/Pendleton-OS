/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPostgresPool } from '../packages/persistence/dist/index.js';

const url = (
  await readFile(
    join(homedir(), 'AppData', 'Local', 'PendletonOS', 'secrets', 'database-url.txt'),
    'utf8',
  )
).trim();
const pool = createPostgresPool(url);
try {
  const result = await pool.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname='public' AND tablename LIKE 'kernel_%'
     ORDER BY tablename`,
  );
  const names = result.rows.map(({ tablename }) => tablename);
  if (names.join(',') !== 'kernel_events,kernel_idempotency,kernel_workflows') {
    throw new Error('DATABASE_KERNEL_TABLES_INCOMPLETE');
  }
  console.log(`DATABASE_RUNTIME_CONNECTION_VERIFIED tables=${names.length}`);
} finally {
  await pool.end();
}
