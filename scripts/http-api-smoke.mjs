/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions, no-empty */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const token = (
  await readFile(
    join(homedir(), 'AppData', 'Local', 'PendletonOS', 'secrets', 'api-token.txt'),
    'utf8',
  )
).trim();
const child = spawn(process.execPath, ['apps/api/dist/server.js'], {
  env: { ...process.env, PENDLETON_API_TOKEN: token, PORT: '3000' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (data) => {
  stderr += String(data);
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:3000/health/ready');
      ready = response.ok;
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`HTTP_API_NOT_READY ${stderr}`);
  const unauthorized = await fetch('http://127.0.0.1:3000/v1/commands', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const marker = new Date().toISOString();
  const response = await fetch('http://127.0.0.1:3000/v1/commands', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      principalId: 'peter',
      project: { projectId: 'pendleton-os' },
      command: {
        commandType: 'artifact.create',
        idempotencyKey: `http-live-${randomUUID()}`,
        interfaceContext: { channel: 'api' },
        payload: {
          title: `Pendleton OS HTTP API Verification ${marker}`,
          text: `Authenticated HTTP API verification completed at ${marker}.`,
        },
      },
      policy: {
        operation: 'artifact.create_internal',
        dataClassification: 'internal',
        grantedScope: true,
        verificationAvailable: true,
      },
    }),
  });
  const result = await response.json();
  if (unauthorized.status !== 401 || response.status !== 202 || result.disposition !== 'accepted') {
    throw new Error('HTTP_API_VERIFICATION_FAILED');
  }
  console.log(
    `HTTP_API_VERIFIED unauthorizedStatus=${unauthorized.status} disposition=${result.disposition} commandId=${result.commandId} workflowId=${result.workflowId}`,
  );
} finally {
  child.kill('SIGTERM');
}
