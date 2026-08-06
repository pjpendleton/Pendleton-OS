import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';

const secretsDirectory = join(homedir(), 'AppData', 'Local', 'PendletonOS', 'secrets');
const clientFile = JSON.parse(
  await readFile(join(secretsDirectory, 'google-oauth-client.json'), 'utf8'),
);
const tokens = JSON.parse(
  await readFile(join(secretsDirectory, 'google-oauth-token.json'), 'utf8'),
);
const client = clientFile.installed ?? clientFile.web;
if (!client?.client_id || !client?.client_secret || !tokens.refresh_token)
  throw new Error('GOOGLE_CREDENTIALS_INCOMPLETE');

const oauth = new google.auth.OAuth2(client.client_id, client.client_secret);
oauth.setCredentials(tokens);
const drive = google.drive({ version: 'v3', auth: oauth });
const name = 'Pendleton OS Runtime';
const escapedName = name.replaceAll("'", "\\'");
const existing = await drive.files.list({
  q: `name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  fields: 'files(id,name)',
});
let folder = existing.data.files?.[0];
if (!folder?.id) {
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id,name',
  });
  folder = created.data;
}
if (!folder.id) throw new Error('GOOGLE_RUNTIME_FOLDER_ID_MISSING');
const observed = await drive.files.get({ fileId: folder.id, fields: 'id,name,mimeType,trashed' });
if (observed.data.name !== name || observed.data.trashed)
  throw new Error('GOOGLE_RUNTIME_FOLDER_VERIFICATION_FAILED');
console.log(`GOOGLE_DRIVE_BOOTSTRAP_COMPLETE folderId=${folder.id}`);
