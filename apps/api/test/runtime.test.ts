import { describe, expect, it, vi } from 'vitest';
import { resolveProjectKnowledgeRoot } from '../src/runtime.js';

const knowledgeResource = (externalId: string) => ({
  resourceId: `knowledge:${externalId}`,
  projectId: 'pendleton-os',
  provider: 'google-drive' as const,
  resourceType: 'folder' as const,
  externalId,
  displayName: 'Project knowledge root',
  status: 'active' as const,
  metadata: { purpose: 'project-knowledge', access: 'read-only' },
  discoveredAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
});

describe('resolveProjectKnowledgeRoot', () => {
  it('uses the dedicated read-only root without consulting the write root', async () => {
    const findResource = vi.fn();
    const result = await resolveProjectKnowledgeRoot(
      {
        getResources: vi.fn().mockResolvedValue([knowledgeResource('knowledge-root')]),
        findResource,
      },
      'pendleton-os',
    );

    expect(result).toBe('knowledge-root');
    expect(findResource).not.toHaveBeenCalled();
  });

  it('falls back to the verified-write root when no knowledge root is registered', async () => {
    const result = await resolveProjectKnowledgeRoot(
      {
        getResources: vi.fn().mockResolvedValue([]),
        findResource: vi.fn().mockResolvedValue({ externalId: 'write-root' }),
      },
      'pendleton-os',
    );

    expect(result).toBe('write-root');
  });

  it('fails closed when more than one knowledge root is active', async () => {
    await expect(
      resolveProjectKnowledgeRoot(
        {
          getResources: vi
            .fn()
            .mockResolvedValue([knowledgeResource('root-one'), knowledgeResource('root-two')]),
          findResource: vi.fn(),
        },
        'pendleton-os',
      ),
    ).rejects.toThrow('PROJECT_KNOWLEDGE_ROOT_AMBIGUOUS');
  });
});
