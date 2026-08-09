import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  EmailAccessService,
  EventRecorder,
  InMemoryEventStore,
  type ProjectRegistry,
  type ReadOnlyEmailClient,
} from '../src/index.js';

const projectRegistry = (status: 'active' | 'candidate' = 'active'): ProjectRegistry => ({
  findById: () =>
    Promise.resolve({
      projectId: 'pendleton-os',
      displayName: 'Pendleton OS',
      aliases: [],
      environment: 'production',
      status,
      authorizedActorIds: ['00000000-0000-4000-8000-000000000001'],
      resourceIds: [],
    }),
  findByAlias: () => Promise.resolve([]),
  list: () => Promise.resolve([]),
  getResources: () => Promise.resolve([]),
  importCandidates: () => Promise.resolve([]),
  setStatus: () => Promise.resolve(undefined),
  findResource: () => Promise.resolve(undefined),
});

const gmailClient = (): ReadOnlyEmailClient => ({
  provider: 'gmail',
  status: () =>
    Promise.resolve({
      provider: 'gmail',
      state: 'ready',
      permissionMode: 'read-only',
      accountId: 'owner@example.com',
    }),
  search: vi.fn().mockResolvedValue([
    {
      provider: 'gmail',
      accountId: 'owner@example.com',
      messageId: 'message-1',
      subject: 'Project update',
      recipients: [],
      snippet: 'Status update',
    },
  ]),
});

describe('EmailAccessService', () => {
  it('performs bounded read-only search and records a redacted audit event', async () => {
    const store = new InMemoryEventStore();
    let id = 0;
    const service = new EmailAccessService(
      [gmailClient()],
      projectRegistry(),
      new EventRecorder({ store, now: () => new Date('2026-08-09T05:00:00.000Z') }),
      () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      (value) => createHash('sha256').update(value).digest('hex'),
      () => new Date('2026-08-09T05:00:00.000Z'),
    );
    const messages = await service.search({
      actorId: '00000000-0000-4000-8000-000000000001',
      projectId: 'pendleton-os',
      provider: 'gmail',
      query: 'Parkco title report',
      maxResults: 5,
    });
    expect(messages).toHaveLength(1);
    const events = await store.findByCorrelation('00000000-0000-4000-8000-000000000001');
    expect(events[0]?.payload).toMatchObject({
      provider: 'gmail',
      permissionMode: 'read-only',
      resultCount: 1,
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain('Parkco title report');
  });

  it('does not search email for an inactive project', async () => {
    const client = gmailClient();
    const search = vi.spyOn(client, 'search');
    const service = new EmailAccessService(
      [client],
      projectRegistry('candidate'),
      new EventRecorder({ store: new InMemoryEventStore() }),
      () => crypto.randomUUID(),
      () => 'hash',
    );
    await expect(
      service.search({
        actorId: '00000000-0000-4000-8000-000000000001',
        projectId: 'pendleton-os',
        provider: 'gmail',
        query: 'project',
      }),
    ).rejects.toThrow('PROJECT_NOT_ACTIVE');
    expect(search).not.toHaveBeenCalled();
  });
});
