import { describe, expect, it } from 'vitest';
import {
  CommandIntakeService,
  InMemoryIdempotencyRegistry,
  standardCommandCatalog,
  type CommandSubmission,
} from '../src/index.js';

const ids = [
  '018f1f91-6f3d-7c16-bc61-55f9fa334f20',
  '018f1f91-6f3d-7c16-bc61-55f9fa334f21',
  '018f1f91-6f3d-7c16-bc61-55f9fa334f22',
  '018f1f91-6f3d-7c16-bc61-55f9fa334f23',
  '018f1f91-6f3d-7c16-bc61-55f9fa334f24',
  '018f1f91-6f3d-7c16-bc61-55f9fa334f25',
];

const validSubmission: CommandSubmission = {
  commandType: 'artifact.create',
  idempotencyKey: 'artifact-create-001',
  actor: {
    actorId: '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
    actorType: 'human',
    roles: ['owner'],
  },
  projectContext: { projectId: 'pendleton-os', environment: 'test' },
  interfaceContext: { channel: 'voice', drivingMode: true },
  payload: { title: 'Daily brief' },
};

const createService = () => {
  let index = 0;
  return new CommandIntakeService({
    catalog: standardCommandCatalog,
    idempotencyRegistry: new InMemoryIdempotencyRegistry(),
    createId: () => ids[index++] ?? ids.at(-1)!,
    now: () => new Date('2026-08-06T15:00:00Z'),
  });
};

describe('CommandIntakeService', () => {
  it('normalizes and accepts a valid supported command', async () => {
    const result = await createService().accept(validSubmission);
    expect(result.disposition).toBe('accepted');
    if (result.disposition === 'accepted') {
      expect(result.command).toMatchObject({
        contractVersion: '1.0.0',
        commandType: 'artifact.create',
        requestedAt: '2026-08-06T15:00:00.000Z',
      });
      expect(result.command.commandId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.command.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('rejects malformed input with stable reason codes', async () => {
    const result = await createService().accept({ commandType: 'bad', payload: [] });
    expect(result.disposition).toBe('rejected');
    if (result.disposition === 'rejected') {
      expect(result.errors.map(({ code }) => code)).toEqual(
        expect.arrayContaining([
          'COMMAND_TYPE_INVALID',
          'IDEMPOTENCY_KEY_INVALID',
          'ACTOR_INVALID',
          'PROJECT_CONTEXT_INVALID',
          'INTERFACE_CONTEXT_INVALID',
          'PAYLOAD_INVALID',
        ]),
      );
    }
  });

  it('rejects unsupported command types', async () => {
    const result = await createService().accept({
      ...validSubmission,
      commandType: 'finance.transfer',
    });
    expect(result).toMatchObject({
      disposition: 'rejected',
      errors: [{ code: 'COMMAND_TYPE_UNSUPPORTED' }],
    });
  });

  it('classifies unresolved update targets as ambiguous', async () => {
    const result = await createService().accept({
      ...validSubmission,
      commandType: 'artifact.update',
      payload: { title: 'Revised' },
    });
    expect(result).toMatchObject({
      disposition: 'rejected',
      errors: [
        {
          code: 'TARGET_RESOURCE_AMBIGUOUS',
          details: { classification: 'ambiguous' },
        },
      ],
    });
  });

  it('returns the original command for an identical retry', async () => {
    const service = createService();
    const first = await service.accept(validSubmission);
    const second = await service.accept(validSubmission);
    expect(first.disposition).toBe('accepted');
    expect(second.disposition).toBe('duplicate');
    if (first.disposition === 'accepted' && second.disposition === 'duplicate') {
      expect(second.existingCommandId).toBe(first.command.commandId);
    }
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    const service = createService();
    await service.accept(validSubmission);
    const result = await service.accept({
      ...validSubmission,
      payload: { title: 'Different brief' },
    });
    expect(result).toMatchObject({
      disposition: 'rejected',
      errors: [{ code: 'IDEMPOTENCY_KEY_CONFLICT', category: 'conflict' }],
    });
  });
});
