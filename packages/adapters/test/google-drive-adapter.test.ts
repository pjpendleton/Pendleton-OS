import { describe, expect, it } from 'vitest';
import { GoogleDriveAdapter, type DriveDocument, type GoogleDriveClient } from '../src/index.js';

class FakeClient implements GoogleDriveClient {
  readonly documents = new Map<string, DriveDocument>();
  getDocument(fileId: string) {
    return Promise.resolve(this.documents.get(fileId));
  }
  searchDocuments(parentFolderId: string, query: string) {
    return Promise.resolve(
      [...this.documents.values()].filter(
        (doc) => doc.parentIds.includes(parentFolderId) && doc.name.includes(query),
      ),
    );
  }
  createDocument(input: { parentFolderId: string; name: string; text: string }) {
    const document: DriveDocument = {
      fileId: `file-${String(this.documents.size + 1)}`,
      name: input.name,
      mimeType: 'application/vnd.google-apps.document',
      parentIds: [input.parentFolderId],
      revisionId: 'rev-1',
      text: input.text,
    };
    this.documents.set(document.fileId, document);
    return Promise.resolve(document);
  }
  updateDocument(input: { fileId: string; expectedRevisionId: string; text: string }) {
    const current = this.documents.get(input.fileId);
    if (current === undefined) return Promise.reject(new Error('not found'));
    const document = { ...current, revisionId: 'rev-2', text: input.text };
    this.documents.set(input.fileId, document);
    return Promise.resolve(document);
  }
}

const createAdapter = () => {
  const client = new FakeClient();
  const adapter = new GoogleDriveAdapter({
    client,
    projects: {
      getProjectRoot: (projectId) =>
        Promise.resolve(projectId === 'pendleton-os' ? 'folder-root' : undefined),
    },
    now: () => new Date('2026-08-06T18:00:00Z'),
  });
  return { client, adapter };
};

describe('GoogleDriveAdapter', () => {
  it('creates a native document inside the verified project root', async () => {
    const { adapter } = createAdapter();
    const result = await adapter.create('pendleton-os', { name: 'Brief', text: 'Hello' });
    expect(result.document).toMatchObject({
      parentIds: ['folder-root'],
      mimeType: 'application/vnd.google-apps.document',
    });
    expect(result.evidence).toMatchObject({
      operation: 'create',
      revisionId: 'rev-1',
      observedAt: '2026-08-06T18:00:00.000Z',
    });
  });
  it('preserves identity and requires the expected revision on update', async () => {
    const { adapter } = createAdapter();
    const created = await adapter.create('pendleton-os', { name: 'Brief', text: 'One' });
    const updated = await adapter.update('pendleton-os', {
      fileId: created.document.fileId,
      expectedRevisionId: 'rev-1',
      text: 'Two',
    });
    expect(updated.document).toMatchObject({
      fileId: created.document.fileId,
      revisionId: 'rev-2',
      text: 'Two',
    });
  });
  it('rejects stale revisions', async () => {
    const { adapter } = createAdapter();
    const created = await adapter.create('pendleton-os', { name: 'Brief', text: 'One' });
    await expect(
      adapter.update('pendleton-os', {
        fileId: created.document.fileId,
        expectedRevisionId: 'stale',
        text: 'Two',
      }),
    ).rejects.toThrow('DRIVE_REVISION_CONFLICT');
  });
  it('rejects documents outside the project boundary', async () => {
    const { adapter, client } = createAdapter();
    client.documents.set('outside', {
      fileId: 'outside',
      name: 'Outside',
      mimeType: 'application/vnd.google-apps.document',
      parentIds: ['other-folder'],
      revisionId: 'rev-1',
      text: 'No',
    });
    await expect(adapter.read('pendleton-os', 'outside')).rejects.toThrow(
      'DRIVE_PROJECT_BOUNDARY_VIOLATION',
    );
  });
  it('returns scoped search results with evidence', async () => {
    const { adapter } = createAdapter();
    await adapter.create('pendleton-os', { name: 'Daily Brief', text: 'A' });
    const results = await adapter.search('pendleton-os', 'Brief');
    expect(results).toHaveLength(1);
    expect(results[0]?.evidence.operation).toBe('search');
  });
});
