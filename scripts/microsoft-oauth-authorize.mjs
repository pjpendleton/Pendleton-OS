/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const secretsDirectory = join(homedir(), 'AppData', 'Local', 'PendletonOS', 'secrets');
const clientPath = join(secretsDirectory, 'microsoft-oauth-client.json');
const tokenPath = join(secretsDirectory, 'microsoft-oauth-token.json');
const client = JSON.parse(await readFile(clientPath, 'utf8'));
if (!client?.client_id) throw new Error('MICROSOFT_OAUTH_CLIENT_INVALID');
const tenant = client.tenant_id ?? 'common';
const scopes = 'openid profile offline_access User.Read Mail.Read';

const server = createServer();
await new Promise((resolve) => server.listen(0, 'localhost', resolve));
const address = server.address();
if (typeof address !== 'object' || address === null) throw new Error('OAUTH_LISTENER_FAILED');
// Microsoft treats localhost loopback ports as interchangeable for native clients.
// Register `http://localhost` in Entra and use the ephemeral local port here.
const redirectUri = `http://localhost:${String(address.port)}`;
const state = randomUUID();
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authorization = new URL(
  `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
);
authorization.search = new URLSearchParams({
  client_id: client.client_id,
  response_type: 'code',
  redirect_uri: redirectUri,
  response_mode: 'query',
  scope: scopes,
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
}).toString();

console.log(`AUTHORIZATION_URL=${authorization.toString()}`);
server.on('request', async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', redirectUri);
    if (url.pathname !== '/' || url.searchParams.get('state') !== state)
      throw new Error('OAUTH_CALLBACK_INVALID');
    const code = url.searchParams.get('code');
    if (!code) throw new Error(url.searchParams.get('error') ?? 'OAUTH_CODE_MISSING');
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.client_id,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          scope: scopes,
          code_verifier: verifier,
        }),
      },
    );
    if (!tokenResponse.ok)
      throw new Error(`MICROSOFT_TOKEN_EXCHANGE_FAILED_${tokenResponse.status}`);
    const tokens = await tokenResponse.json();
    if (!tokens.refresh_token) throw new Error('OAUTH_REFRESH_TOKEN_MISSING');
    tokens.expires_at = Date.now() + Number(tokens.expires_in ?? 3600) * 1000;
    await writeFile(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Pendleton OS Microsoft authorization completed. You may close this tab.');
    console.log('AUTHORIZATION_COMPLETE');
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Authorization failed. Return to Codex for assistance.');
    console.error(error instanceof Error ? error.message : 'OAUTH_UNKNOWN_ERROR');
  } finally {
    server.close();
  }
});
