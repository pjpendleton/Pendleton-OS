import { describe, expect, it } from 'vitest';
import { EventRecorder, InMemoryEventStore } from '../src/index.js';

const request = {
  eventId: 'event-1',
  eventType: 'command.accepted',
  eventVersion: 1,
  occurredAt: '2026-08-06T20:00:00.000Z',
  correlationId: 'correlation-1',
  commandId: 'command-1',
  workflowId: 'workflow-1',
  actorId: 'actor-1',
  projectId: 'project-1',
  payload: {
    disposition: 'accepted',
    accessToken: 'do-not-store',
    nested: { password: 'hidden', safe: 'value' },
  },
};

describe('EventRecorder', () => {
  it('records immutable correlated events with provider-independent envelopes', async () => {
    const store = new InMemoryEventStore();
    const recorder = new EventRecorder({ store, now: () => new Date('2026-08-06T20:00:01Z') });
    const event = await recorder.record(request);
    expect(event).toMatchObject({
      recordedAt: '2026-08-06T20:00:01.000Z',
      correlationId: 'correlation-1',
      commandId: 'command-1',
    });
    expect(Object.isFrozen(event)).toBe(true);
  });
  it('redacts secrets recursively before persistence', async () => {
    const store = new InMemoryEventStore();
    const recorder = new EventRecorder({ store });
    const event = await recorder.record(request);
    expect(event.payload).toEqual({
      disposition: 'accepted',
      accessToken: '[REDACTED]',
      nested: { password: '[REDACTED]', safe: 'value' },
    });
  });
  it('rejects duplicate event identifiers', async () => {
    const store = new InMemoryEventStore();
    const recorder = new EventRecorder({ store });
    await recorder.record(request);
    await expect(recorder.record(request)).rejects.toThrow('EVENT_ID_CONFLICT');
  });
  it('reconstructs activity by correlation, command, and workflow', async () => {
    const store = new InMemoryEventStore();
    const recorder = new EventRecorder({ store });
    await recorder.record(request);
    await recorder.record({ ...request, eventId: 'event-2', eventType: 'workflow.completed' });
    expect(await store.findByCorrelation('correlation-1')).toHaveLength(2);
    expect(await store.findByCommand('command-1')).toHaveLength(2);
    expect(await store.findByWorkflow('workflow-1')).toHaveLength(2);
  });
  it('requires a valid version and correlation identifier', async () => {
    const recorder = new EventRecorder({ store: new InMemoryEventStore() });
    await expect(recorder.record({ ...request, eventVersion: 0 })).rejects.toThrow(
      'EVENT_VERSION_INVALID',
    );
    await expect(recorder.record({ ...request, correlationId: '' })).rejects.toThrow(
      'EVENT_CORRELATION_REQUIRED',
    );
  });
});
