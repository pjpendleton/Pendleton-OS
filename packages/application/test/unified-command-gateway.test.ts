import { describe, expect, it, vi } from 'vitest';
import {
  CommandIntakeService,
  ContextResolutionService,
  InMemoryIdempotencyRegistry,
  InMemoryIdentityDirectory,
  InMemoryProjectDirectory,
  PolicyEngine,
  UnifiedCommandGateway,
  standardCommandCatalog,
} from '../src/index.js';

const actorId = '018f1f91-6f3d-7c16-bc61-55f9fa334f12';
const ids = ['correlation-1', 'command-1', 'policy-1'];
const createGateway = () => {
  let index = 0;
  const dispatch = vi.fn().mockResolvedValue({ workflowId: 'workflow-1' });
  const gateway = new UnifiedCommandGateway({
    contexts: new ContextResolutionService({
      identities: new InMemoryIdentityDirectory([
        {
          principalId: 'principal-1',
          actor: { actorId, actorType: 'human', roles: ['owner'] },
          status: 'active',
        },
      ]),
      projects: new InMemoryProjectDirectory([
        {
          projectId: 'pendleton-os',
          aliases: ['os'],
          environment: 'test',
          status: 'active',
          authorizedActorIds: [actorId],
          resourceIds: ['file-1'],
        },
      ]),
    }),
    intake: new CommandIntakeService({
      catalog: standardCommandCatalog,
      idempotencyRegistry: new InMemoryIdempotencyRegistry(),
      createId: () => ids[index++] ?? `id-${String(index)}`,
      now: () => new Date('2026-08-06T21:00:00Z'),
    }),
    policy: new PolicyEngine(),
    workflows: { dispatch },
    createId: () => ids[index++] ?? `id-${String(index)}`,
    now: () => new Date('2026-08-06T21:00:01Z'),
  });
  return { gateway, dispatch };
};
const request = {
  principalId: 'principal-1',
  project: { projectId: 'pendleton-os' } as const,
  command: {
    commandType: 'artifact.create',
    idempotencyKey: 'gateway-key-001',
    interfaceContext: { channel: 'api' },
    payload: { title: 'Brief' },
  },
  policy: {
    operation: 'artifact.create_internal' as const,
    dataClassification: 'internal' as const,
    grantedScope: true,
    verificationAvailable: true,
  },
};

describe('UnifiedCommandGateway', () => {
  it('dispatches only after context, intake, and policy allow', async () => {
    const { gateway, dispatch } = createGateway();
    expect(await gateway.execute(request)).toMatchObject({
      disposition: 'accepted',
      workflowId: 'workflow-1',
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it('does not dispatch unresolved identity or project context', async () => {
    const { gateway, dispatch } = createGateway();
    expect(await gateway.execute({ ...request, principalId: 'unknown' })).toMatchObject({
      disposition: 'rejected',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not dispatch denied policy decisions', async () => {
    const { gateway, dispatch } = createGateway();
    expect(
      await gateway.execute({ ...request, policy: { ...request.policy, grantedScope: false } }),
    ).toMatchObject({ disposition: 'denied' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('returns confirmation gates without dispatching', async () => {
    const { gateway, dispatch } = createGateway();
    expect(
      await gateway.execute({
        ...request,
        targetResourceId: 'file-1',
        command: {
          ...request.command,
          commandType: 'artifact.update',
          payload: { title: 'Changed' },
        },
        policy: { ...request.policy, operation: 'provider.mutate' },
      }),
    ).toMatchObject({ disposition: 'confirmation_required' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
