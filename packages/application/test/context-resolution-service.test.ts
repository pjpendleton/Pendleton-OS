import { describe, expect, it } from 'vitest';
import {
  ContextResolutionService,
  InMemoryIdentityDirectory,
  InMemoryProjectDirectory,
  type IdentityRecord,
  type ProjectRecord,
} from '../src/index.js';

const ownerId = '018f1f91-6f3d-7c16-bc61-55f9fa334f12';
const identities: readonly IdentityRecord[] = [
  {
    principalId: 'google:owner@example.test',
    actor: { actorId: ownerId, actorType: 'human', roles: ['owner'] },
    status: 'active',
  },
  {
    principalId: 'google:disabled@example.test',
    actor: {
      actorId: '018f1f91-6f3d-7c16-bc61-55f9fa334f13',
      actorType: 'human',
      roles: ['operator'],
    },
    status: 'disabled',
  },
  {
    principalId: 'google:outsider@example.test',
    actor: {
      actorId: '018f1f91-6f3d-7c16-bc61-55f9fa334f14',
      actorType: 'human',
      roles: ['operator'],
    },
    status: 'active',
  },
];

const projects: readonly ProjectRecord[] = [
  {
    projectId: 'pendleton-os',
    aliases: ['Pendleton OS', 'foundation'],
    environment: 'test',
    status: 'active',
    authorizedActorIds: [ownerId],
    resourceIds: ['drive:system-design'],
  },
  {
    projectId: 'pendleton-archive',
    aliases: ['archive', 'foundation'],
    environment: 'test',
    status: 'archived',
    authorizedActorIds: [ownerId],
    resourceIds: [],
  },
];

const createService = () =>
  new ContextResolutionService({
    identities: new InMemoryIdentityDirectory(identities),
    projects: new InMemoryProjectDirectory(projects),
  });

describe('ContextResolutionService', () => {
  it('resolves an active actor, authorized project, and registered target', async () => {
    const result = await createService().resolve({
      principalId: 'google:owner@example.test',
      project: { projectId: 'pendleton-os' },
      targetResourceId: 'drive:system-design',
    });
    expect(result).toEqual({
      disposition: 'resolved',
      actor: { actorId: ownerId, actorType: 'human', roles: ['owner'] },
      projectContext: {
        projectId: 'pendleton-os',
        environment: 'test',
        targetResourceId: 'drive:system-design',
      },
    });
  });

  it('resolves a unique project alias case-insensitively', async () => {
    const result = await createService().resolve({
      principalId: 'google:owner@example.test',
      project: { alias: 'PENDLETON OS' },
    });
    expect(result).toMatchObject({
      disposition: 'resolved',
      projectContext: { projectId: 'pendleton-os' },
    });
  });

  it('rejects an unknown principal', async () => {
    const result = await createService().resolve({
      principalId: 'google:unknown@example.test',
      project: { projectId: 'pendleton-os' },
    });
    expect(result).toMatchObject({
      disposition: 'rejected',
      errors: [{ code: 'IDENTITY_NOT_FOUND', category: 'authentication' }],
    });
  });

  it('rejects a disabled identity', async () => {
    const result = await createService().resolve({
      principalId: 'google:disabled@example.test',
      project: { projectId: 'pendleton-os' },
    });
    expect(result).toMatchObject({
      disposition: 'rejected',
      errors: [{ code: 'IDENTITY_DISABLED' }],
    });
  });

  it('rejects an ambiguous project alias', async () => {
    const result = await createService().resolve({
      principalId: 'google:owner@example.test',
      project: { alias: 'foundation' },
    });
    expect(result).toMatchObject({
      disposition: 'rejected',
      errors: [{ code: 'PROJECT_AMBIGUOUS', details: { candidateCount: 2 } }],
    });
  });

  it('rejects an actor without project access', async () => {
    const result = await createService().resolve({
      principalId: 'google:outsider@example.test',
      project: { projectId: 'pendleton-os' },
    });
    expect(result).toMatchObject({
      disposition: 'rejected',
      errors: [{ code: 'PROJECT_ACCESS_DENIED', category: 'authorization' }],
    });
  });

  it('rejects an archived project', async () => {
    const result = await createService().resolve({
      principalId: 'google:owner@example.test',
      project: { projectId: 'pendleton-archive' },
    });
    expect(result).toMatchObject({
      disposition: 'rejected',
      errors: [{ code: 'PROJECT_ARCHIVED' }],
    });
  });

  it('rejects a target outside the resolved project', async () => {
    const result = await createService().resolve({
      principalId: 'google:owner@example.test',
      project: { projectId: 'pendleton-os' },
      targetResourceId: 'drive:unknown',
    });
    expect(result).toMatchObject({
      disposition: 'rejected',
      errors: [{ code: 'TARGET_RESOURCE_NOT_FOUND' }],
    });
  });
});
