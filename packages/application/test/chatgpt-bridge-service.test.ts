import { ChatGptBridgeService, InMemoryEventStore, EventRecorder } from '../src/index.js';
import { describe, expect, it, vi } from 'vitest';

describe('ChatGptBridgeService', () => {
  it('persists inventory and records a correlated audit event', async () => {
    const receipt = {
      snapshotId: 'chatgpt-snapshot:1',
      replayed: false,
      receivedAt: '2026-08-25T17:00:01.000Z',
      projectCount: 1,
      conversationCount: 0,
      sourceCount: 0,
    };
    const persistInventory = vi.fn().mockResolvedValue(receipt);
    const events = new InMemoryEventStore();
    let identifier = 0;
    const service = new ChatGptBridgeService(
      {
        persistInventory,
        listProjects: () => Promise.resolve([]),
        findProject: () => Promise.resolve(undefined),
      },
      new EventRecorder({ store: events }),
      () => String(++identifier),
      () => new Date('2026-08-25T17:00:01.000Z'),
    );
    const input = {
      contractVersion: '1.0.0',
      snapshotKey: 'snapshot-123',
      scope: 'project-list',
      observedCollections: ['projects'],
      collectorVersion: '1.0.0',
      capturedAt: '2026-08-25T17:00:00.000Z',
      workspaceLabel: "Pendleton's Workspace",
      pageUrl: 'https://chatgpt.com/projects',
      projects: [
        {
          sourceProjectKey: 'g-p-project123',
          locatorKind: 'provider-id',
          displayName: 'Pacific Edge',
          conversations: [],
          sources: [],
        },
      ],
    } as const;
    expect(await service.ingest(input, 'actor-1')).toEqual(receipt);
    expect(persistInventory).toHaveBeenCalledWith(
      'chatgpt-snapshot:1',
      input,
      '2026-08-25T17:00:01.000Z',
    );
    expect(await events.findByCorrelation('chatgpt-snapshot:1')).toMatchObject([
      {
        eventType: 'connector.chatgpt.inventory.accepted',
        actorId: 'actor-1',
        payload: { projectCount: 1, replayed: false },
      },
    ]);
  });
});
