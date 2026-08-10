/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
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

const driveSearchTerms = (query: string): readonly string[] => {
  const ignored = new Set([
    'about',
    'from',
    'have',
    'project',
    'that',
    'the',
    'this',
    'what',
    'when',
    'where',
    'with',
  ]);
  const terms = query
    .normalize('NFKD')
    .split(/[^a-zA-Z0-9]+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !ignored.has(term));
  return [...new Set(terms)].slice(0, 6);
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

  async searchDocuments(
    parentFolderId: string,
    query: string,
    maxResults = 10,
  ): Promise<readonly DriveDocument[]> {
    const terms = driveSearchTerms(query);
    if (terms.length === 0) return [];
    const clauses = terms.flatMap((term) => {
      const escaped = term.replaceAll("'", "\\'");
      return [`name contains '${escaped}'`, `fullText contains '${escaped}'`];
    });
    const response = await this.#drive.files.list({
      q: `(${clauses.join(' or ')}) and mimeType='application/vnd.google-apps.document' and trashed=false`,
      fields: 'files(id,parents)',
      pageSize: Math.min(Math.max(maxResults * 8, 20), 100),
    });
    const parentCache = new Map<string, readonly string[]>();
    const ancestryFor = async (initialParents: readonly string[]): Promise<readonly string[]> => {
      const ancestors = new Set(initialParents);
      const queue = [...initialParents];
      for (let inspected = 0; queue.length > 0 && inspected < 100; inspected += 1) {
        const folderId = queue.shift();
        if (folderId === undefined || folderId === parentFolderId) continue;
        let parents = parentCache.get(folderId);
        if (parents === undefined) {
          try {
            const folder = await this.#drive.files.get({
              fileId: folderId,
              fields: 'id,parents,trashed',
            });
            parents = folder.data.trashed ? [] : (folder.data.parents ?? []);
          } catch {
            parents = [];
          }
          parentCache.set(folderId, parents);
        }
        for (const parent of parents) {
          if (ancestors.has(parent)) continue;
          ancestors.add(parent);
          queue.push(parent);
        }
      }
      return [...ancestors];
    };
    const documents: DriveDocument[] = [];
    for (const file of response.data.files ?? []) {
      if (!file.id) continue;
      const ancestorIds = await ancestryFor(file.parents ?? []);
      if (!ancestorIds.includes(parentFolderId)) continue;
      const document = await this.getDocument(file.id);
      if (document !== undefined) documents.push({ ...document, ancestorIds });
      if (documents.length === maxResults) break;
    }
    return documents;
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
