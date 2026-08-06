/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/await-thenable */
import { google, type Auth } from 'googleapis';
import type { ArtifactObservationReader } from '@pendleton-os/application';
import type { DriveDocument, GoogleDriveClient } from './google-drive-adapter.js';

const textContent = (document: { body?: { content?: readonly unknown[] } }): string => {
  const content = document.body?.content ?? [];
  return content
    .flatMap((item) => {
      if (typeof item !== 'object' || item === null || !('paragraph' in item)) return [];
      const paragraph = item.paragraph;
      if (typeof paragraph !== 'object' || paragraph === null || !('elements' in paragraph))
        return [];
      return Array.isArray(paragraph.elements) ? paragraph.elements : [];
    })
    .map((element) => {
      if (typeof element !== 'object' || element === null || !('textRun' in element)) return '';
      const run = element.textRun;
      return typeof run === 'object' &&
        run !== null &&
        'content' in run &&
        typeof run.content === 'string'
        ? run.content
        : '';
    })
    .join('')
    .replace(/\n$/, '');
};

export class GoogleApisDriveClient implements GoogleDriveClient, ArtifactObservationReader {
  readonly #drive;
  readonly #docs;

  constructor(auth: Auth.OAuth2Client) {
    this.#drive = google.drive({ version: 'v3', auth });
    this.#docs = google.docs({ version: 'v1', auth });
  }

  async getDocument(fileId: string): Promise<DriveDocument | undefined> {
    const [file, document, revisions] = await Promise.all([
      this.#drive.files.get({ fileId, fields: 'id,name,mimeType,parents,trashed' }),
      this.#docs.documents.get({ documentId: fileId }),
      this.#drive.revisions.list({ fileId, fields: 'revisions(id)' }),
    ]);
    if (file.data.trashed || file.data.mimeType !== 'application/vnd.google-apps.document')
      return undefined;
    const revisionId = revisions.data.revisions?.at(-1)?.id;
    if (!file.data.id || !file.data.name || !revisionId)
      throw new Error('DRIVE_OBSERVATION_INCOMPLETE');
    return {
      fileId: file.data.id,
      name: file.data.name,
      mimeType: 'application/vnd.google-apps.document',
      parentIds: file.data.parents ?? [],
      revisionId,
      text: textContent(document.data),
    };
  }

  async observe(fileId: string) {
    return this.getDocument(fileId);
  }

  async searchDocuments(parentFolderId: string, query: string): Promise<readonly DriveDocument[]> {
    const escaped = query.replaceAll("'", "\\'");
    const response = await this.#drive.files.list({
      q: `'${parentFolderId}' in parents and name contains '${escaped}' and mimeType='application/vnd.google-apps.document' and trashed=false`,
      fields: 'files(id)',
    });
    const documents = await Promise.all(
      (response.data.files ?? []).map(({ id }) => (id ? this.getDocument(id) : undefined)),
    );
    return documents.filter((document): document is DriveDocument => document !== undefined);
  }

  async createDocument(input: {
    parentFolderId: string;
    name: string;
    text: string;
  }): Promise<DriveDocument> {
    const created = await this.#drive.files.create({
      requestBody: {
        name: input.name,
        mimeType: 'application/vnd.google-apps.document',
        parents: [input.parentFolderId],
      },
      fields: 'id',
    });
    if (!created.data.id) throw new Error('DRIVE_CREATE_ID_MISSING');
    if (input.text.length > 0) {
      await this.#docs.documents.batchUpdate({
        documentId: created.data.id,
        requestBody: { requests: [{ insertText: { location: { index: 1 }, text: input.text } }] },
      });
    }
    const observed = await this.getDocument(created.data.id);
    if (!observed) throw new Error('DRIVE_CREATE_READBACK_FAILED');
    return observed;
  }

  async updateDocument(input: {
    fileId: string;
    expectedRevisionId: string;
    text: string;
  }): Promise<DriveDocument> {
    const current = await this.getDocument(input.fileId);
    if (!current) throw new Error('DRIVE_DOCUMENT_NOT_FOUND');
    if (current.revisionId !== input.expectedRevisionId) throw new Error('DRIVE_REVISION_CONFLICT');
    const requests: object[] = [];
    if (current.text.length > 0)
      requests.push({
        deleteContentRange: { range: { startIndex: 1, endIndex: current.text.length + 1 } },
      });
    if (input.text.length > 0)
      requests.push({ insertText: { location: { index: 1 }, text: input.text } });
    if (requests.length > 0)
      await this.#docs.documents.batchUpdate({
        documentId: input.fileId,
        requestBody: { requests },
      });
    const observed = await this.getDocument(input.fileId);
    if (!observed) throw new Error('DRIVE_UPDATE_READBACK_FAILED');
    return observed;
  }
}

export const createGoogleOAuthClient = (
  client: { client_id: string; client_secret: string },
  tokens: object,
): Auth.OAuth2Client => {
  const oauth = new google.auth.OAuth2(client.client_id, client.client_secret);
  oauth.setCredentials(tokens);
  return oauth;
};
