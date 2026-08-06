import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';

const secretsDirectory = join(homedir(), 'AppData', 'Local', 'PendletonOS', 'secrets');
const clientPath = join(secretsDirectory, 'google-oauth-client.json');
const tokenPath = join(secretsDirectory, 'google-oauth-token.json');
const clientFile = JSON.parse(await readFile(clientPath, 'utf8'));
const client = clientFile.installed ?? clientFile.web;
if (!client?.client_id || !client?.client_secret) throw new Error('GOOGLE_OAUTH_CLIENT_INVALID');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (typeof address !== 'object' || address === null) throw new Error('OAUTH_LISTENER_FAILED');
const redirectUri = `http://127.0.0.1:${String(address.port)}/oauth2/callback`;
const oauth = new google.auth.OAuth2(client.client_id, client.client_secret, redirectUri);
const state = crypto.randomUUID();
const authorizationUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file'],
  state,
});

console.log(`AUTHORIZATION_URL=${authorizationUrl}`);
server.on('request', async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', redirectUri);
    if (url.pathname !== '/oauth2/callback' || url.searchParams.get('state') !== state)
      throw new Error('OAUTH_CALLBACK_INVALID');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('OAUTH_CODE_MISSING');
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) throw new Error('OAUTH_REFRESH_TOKEN_MISSING');
    await writeFile(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Pendleton OS Google authorization completed. You may close this tab.');
    console.log('AUTHORIZATION_COMPLETE');
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Authorization failed. Return to Codex for assistance.');
    console.error(error instanceof Error ? error.message : 'OAUTH_UNKNOWN_ERROR');
  } finally {
    server.close();
  }
});
