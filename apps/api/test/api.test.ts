import { describe, expect, it, vi } from 'vitest';
import { buildApi } from '../src/index.js';

describe('POST /v1/commands', () => {
  it('routes command requests only through the unified gateway', async () => {
    const execute = vi.fn().mockResolvedValue({
      disposition: 'accepted',
      commandId: 'command-1',
      workflowId: 'workflow-1',
      correlationId: 'correlation-1',
    });
    const app = buildApi({ execute });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      payload: { command: { commandType: 'artifact.create' } },
    });
    expect(response.statusCode).toBe(202);
    expect(execute).toHaveBeenCalledOnce();
    await app.close();
  });
  it.each([
    ['duplicate', 200],
    ['confirmation_required', 409],
    ['escalated', 409],
    ['denied', 403],
    ['rejected', 400],
  ] as const)('maps %s to an explicit transport status', async (disposition, status) => {
    const app = buildApi({ execute: () => Promise.resolve({ disposition }) });
    const response = await app.inject({ method: 'POST', url: '/v1/commands', payload: {} });
    expect(response.statusCode).toBe(status);
    await app.close();
  });
});

describe('POST /v1/chat/artifacts', () => {
  it('maps the narrow chat payload to a server-controlled kernel request', async () => {
    const execute = vi.fn().mockResolvedValue({
      disposition: 'accepted',
      commandId: 'command-1',
      workflowId: 'workflow-1',
      correlationId: 'correlation-1',
    });
    const app = buildApi(
      { execute },
      {
        apiToken: 'a'.repeat(32),
        chatAction: { principalId: 'peter', projectId: 'pendleton-os' },
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/artifacts',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
      payload: { title: 'Drive note', text: 'Created from ChatGPT.' },
    });
    expect(response.statusCode).toBe(202);
    const submitted: unknown = execute.mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      principalId: 'peter',
      project: { projectId: 'pendleton-os' },
      command: {
        commandType: 'artifact.create',
        interfaceContext: { channel: 'mobile' },
        payload: { title: 'Drive note', text: 'Created from ChatGPT.' },
      },
      policy: {
        operation: 'artifact.create_internal',
        dataClassification: 'internal',
        grantedScope: true,
        verificationAvailable: true,
      },
    });
    await app.close();
  });

  it('rejects missing content before it reaches the kernel', async () => {
    const execute = vi.fn();
    const app = buildApi(
      { execute },
      {
        apiToken: 'a'.repeat(32),
        chatAction: { principalId: 'peter', projectId: 'pendleton-os' },
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/artifacts',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
      payload: { title: '', text: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('voice gateway', () => {
  it('publishes authenticated, versioned voice capabilities', async () => {
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      { apiToken: 'a'.repeat(32) },
    );
    const response = await app.inject({
      method: 'GET',
      url: '/v1/voice/capabilities',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      contractVersion: '1.0.0',
      channel: 'voice',
      drivingModeSupported: true,
      interruptionSupported: true,
      actions: ['artifact.create'],
      consequentialActionsRequireConfirmation: true,
    });
    await app.close();
  });

  it('maps a driving voice capture through the unified gateway', async () => {
    const execute = vi.fn().mockResolvedValue({
      disposition: 'accepted',
      commandId: 'command-voice-1',
      workflowId: 'workflow-voice-1',
      correlationId: 'correlation-voice-1',
    });
    const app = buildApi(
      { execute },
      {
        apiToken: 'a'.repeat(32),
        voiceAction: { principalId: 'peter', projectId: 'pendleton-os' },
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/voice/artifacts',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
      payload: {
        idempotencyKey: 'voice-session-1-utterance-1',
        title: 'Driving note',
        text: 'Follow up on the title report.',
        drivingMode: true,
      },
    });
    expect(response.statusCode).toBe(202);
    expect(execute).toHaveBeenCalledWith({
      principalId: 'peter',
      project: { projectId: 'pendleton-os' },
      command: {
        commandType: 'artifact.create',
        idempotencyKey: 'voice-session-1-utterance-1',
        interfaceContext: { channel: 'voice', drivingMode: true },
        payload: { title: 'Driving note', text: 'Follow up on the title report.' },
      },
      policy: {
        operation: 'artifact.create_internal',
        dataClassification: 'internal',
        grantedScope: true,
        verificationAvailable: true,
      },
    });
    await app.close();
  });

  it('requires an idempotency key before voice work reaches the kernel', async () => {
    const execute = vi.fn();
    const app = buildApi(
      { execute },
      {
        apiToken: 'a'.repeat(32),
        voiceAction: { principalId: 'peter', projectId: 'pendleton-os' },
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/voice/artifacts',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
      payload: { title: 'Note', text: 'Body', drivingMode: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      errors: [{ code: 'IDEMPOTENCY_KEY_REQUIRED' }],
    });
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('health endpoints', () => {
  it('reports liveness and readiness', async () => {
    const app = buildApi({ execute: () => Promise.resolve({ disposition: 'accepted' }) });
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.json()).toMatchObject({ service: 'pendleton-os-api', status: 'ready' });
    await app.close();
  });
});
