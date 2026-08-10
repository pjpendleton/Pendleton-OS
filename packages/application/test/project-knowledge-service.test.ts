import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  EventRecorder,
  InMemoryEventStore,
  ProjectKnowledgeService,
  type EmailAccessService,
  type ProjectDocumentKnowledgeSource,
  type ProjectRegistry,
} from '../src/index.js';

const actorId = '00000000-0000-4000-8000-000000000001';

const projects = (status: 'active' | 'candidate' = 'active'): ProjectRegistry => ({
  findById: () =>
    Promise.resolve({
      projectId: 'pendleton-os',
      displayName: 'Pendleton OS',
      aliases: ['os'],
      environment: 'production',
      status,
      authorizedActorIds: [actorId],
      resourceIds: ['drive-root'],
    }),
  findByAlias: () => Promise.resolve([]),
  list: () => Promise.resolve([]),
  getResources: () => Promise.resolve([]),
  importCandidates: () => Promise.resolve([]),
  setStatus: () => Promise.resolve(undefined),
  findResource: () => Promise.resolve(undefined),
});

describe('ProjectKnowledgeService', () => {
  it('aggregates project-scoped sources and records only a query hash', async () => {
    const store = new InMemoryEventStore();
    let id = 0;
    const documents: ProjectDocumentKnowledgeSource = {
      search: vi.fn().mockResolvedValue([
        {
          provider: 'google-drive',
          kind: 'document',
          sourceId: 'doc-1',
          title: 'System Design',
          excerpt: 'Architecture context',
          sourceLabel: 'Google Drive',
        },
      ]),
    };
    const email = {
      search: vi.fn().mockImplementation(({ provider }: { provider: string }) =>
        Promise.resolve([
          {
            provider,
            accountId: provider === 'gmail' ? 'gmail@example.com' : 'owner@example.com',
            messageId: `${provider}-1`,
            subject: `${provider} update`,
            recipients: [],
            snippet: 'Project status',
          },
        ]),
      ),
    } as unknown as EmailAccessService;
    const service = new ProjectKnowledgeService({
      projects: projects(),
      documents,
      email,
      events: new EventRecorder({ store }),
      createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      hashQuery: (value) => createHash('sha256').update(value).digest('hex'),
      now: () => new Date('2026-08-09T23:00:00.000Z'),
    });

    const result = await service.search({
      actorId,
      projectId: 'pendleton-os',
      query: 'executive brain',
      maxResults: 3,
    });

    expect(result).toMatchObject({
      permissionMode: 'read-only',
      items: [
        { provider: 'google-drive', title: 'System Design' },
        { provider: 'gmail', title: 'gmail update' },
        { provider: 'microsoft-graph', title: 'microsoft-graph update' },
      ],
      sources: [
        { provider: 'google-drive', state: 'ready', resultCount: 1 },
        { provider: 'gmail', state: 'ready', resultCount: 1 },
        { provider: 'microsoft-graph', state: 'ready', resultCount: 1 },
      ],
    });
    const events = await store.findByCorrelation('00000000-0000-4000-8000-000000000001');
    expect(events[0]).toMatchObject({
      eventType: 'knowledge.search.completed',
      projectId: 'pendleton-os',
      payload: { permissionMode: 'read-only', resultCount: 3 },
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain('executive brain');
    expect(String(events[0]?.payload.querySha256)).toHaveLength(64);
  });

  it('returns partial source status without inventing unavailable results', async () => {
    const documents = { search: vi.fn().mockRejectedValue(new Error('DRIVE_UNAVAILABLE')) };
    const email = {
      search: vi
        .fn()
        .mockImplementation(({ provider }: { provider: string }) =>
          provider === 'gmail'
            ? Promise.resolve([])
            : Promise.reject(new Error('MICROSOFT_AUTHORIZATION_REQUIRED')),
        ),
    } as unknown as EmailAccessService;
    const service = new ProjectKnowledgeService({
      projects: projects(),
      documents,
      email,
      events: new EventRecorder({ store: new InMemoryEventStore() }),
      createId: () => '00000000-0000-4000-8000-000000000001',
      hashQuery: () => 'a'.repeat(64),
    });
    const result = await service.search({ actorId, projectId: 'pendleton-os', query: 'status' });
    expect(result.items).toEqual([]);
    expect(result.sources).toEqual([
      {
        provider: 'google-drive',
        state: 'unavailable',
        resultCount: 0,
        detail: 'DRIVE_UNAVAILABLE',
      },
      { provider: 'gmail', state: 'ready', resultCount: 0 },
      {
        provider: 'microsoft-graph',
        state: 'unavailable',
        resultCount: 0,
        detail: 'MICROSOFT_AUTHORIZATION_REQUIRED',
      },
    ]);
  });

  it('does not query sources for an inactive project', async () => {
    const search = vi.fn();
    const service = new ProjectKnowledgeService({
      projects: projects('candidate'),
      documents: { search },
      email: { search } as unknown as EmailAccessService,
      events: new EventRecorder({ store: new InMemoryEventStore() }),
      createId: () => '00000000-0000-4000-8000-000000000001',
      hashQuery: () => 'a'.repeat(64),
    });
    await expect(
      service.search({ actorId, projectId: 'pendleton-os', query: 'status' }),
    ).rejects.toThrow('PROJECT_NOT_ACTIVE');
    expect(search).not.toHaveBeenCalled();
  });
});
