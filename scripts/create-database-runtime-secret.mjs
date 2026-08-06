/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const directory = join(homedir(), 'AppData', 'Local', 'PendletonOS', 'secrets');
const passwordPath = join(directory, 'database-runtime-password.txt');
const urlPath = join(directory, 'database-url.txt');
const password = await readFile(passwordPath, 'utf8')
  .then((value) => value.trim())
  .catch(() => randomBytes(32).toString('base64url'));
const encoded = encodeURIComponent(password);
const url = `postgresql://pendleton_runtime.fqzwkiuxghqcoequcykg:${encoded}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`;

await mkdir(directory, { recursive: true });
await writeFile(passwordPath, password, { encoding: 'utf8', mode: 0o600 });
await writeFile(urlPath, url, { encoding: 'utf8', mode: 0o600 });
console.log('DATABASE_RUNTIME_SECRET_CREATED');
