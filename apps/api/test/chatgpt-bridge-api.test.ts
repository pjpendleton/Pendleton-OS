import type { ChatGptBridgeService, ChatGptInventoryInput } from '@pendleton-os/application';
import { describe, expect, it, vi } from 'vitest';
import { buildApi } from '../src/index.js';

const inventory = {
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
      canonicalUrl: 'https://chatgpt.com/g/g-p-project123/project',
      conversations: [],
      sources: [],
    },
  ],
} satisfies ChatGptInventoryInput;

describe('ChatGPT bridge API', () => {
  it('accepts metadata with the scoped bridge credential and exposes it to an administrator', async () => {
    const ingest = vi.fn().mockResolvedValue({
      snapshotId: 'chatgpt-snapshot:1',
      replayed: false,
      receivedAt: '2026-08-25T17:00:01.000Z',
      projectCount: 1,
      conversationCount: 0,
      sourceCount: 0,
    });
    const listProjects = vi.fn().mockResolvedValue([
      {
        sourceProjectKey: 'g-p-project123',
        locatorKind: 'provider-id',
        displayName: 'Pacific Edge',
        workspaceLabel: "Pendleton's Workspace",
        collectorVersion: '1.0.0',
        status: 'active',
        lastObservedAt: '2026-08-25T17:00:00.000Z',
        conversationCount: 0,
        sourceCount: 0,
      },
    ]);
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        chatGptBridge: {
          service: { ingest, listProjects } as unknown as ChatGptBridgeService,
          actorId: 'actor-1',
          bridgeToken: 'b'.repeat(32),
        },
      },
    );
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/connectors/chatgpt/inventory',
      headers: { authorization: `Bridge ${'b'.repeat(32)}` },
      payload: inventory,
    });
    expect(accepted.statusCode).toBe(202);
    expect(ingest).toHaveBeenCalledWith(inventory, 'actor-1');

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/connectors/chatgpt/projects',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ projects: [{ displayName: 'Pacific Edge' }] });
    await app.close();
  });

  it('rejects administrator credentials at ingestion and refuses uncontracted content fields', async () => {
    const ingest = vi.fn();
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        chatGptBridge: {
          service: { ingest } as unknown as ChatGptBridgeService,
          actorId: 'actor-1',
          bridgeToken: 'b'.repeat(32),
        },
      },
    );
    const wrongCredential = await app.inject({
      method: 'POST',
      url: '/v1/connectors/chatgpt/inventory',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
      payload: inventory,
    });
    expect(wrongCredential.statusCode).toBe(401);

    const withChatBody = {
      ...inventory,
      projects: [{ ...inventory.projects[0], content: 'This must never be accepted.' }],
    };
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/connectors/chatgpt/inventory',
      headers: { authorization: `Bridge ${'b'.repeat(32)}` },
      payload: withChatBody,
    });
    expect(rejected.statusCode).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });
});
