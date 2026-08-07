import { describe, expect, it, vi } from 'vitest';
import { buildApi } from '../src/index.js';
import { ConversationRuntime, type ConversationRepository } from '@pendleton-os/application';
import type {
  ConversationSession,
  ConversationStatus,
  ConversationTurn,
} from '@pendleton-os/contracts';

const conversationRuntime = (): ConversationRuntime => {
  const sessions = new Map<string, ConversationSession>();
  const turns: ConversationTurn[] = [];
  const repository: ConversationRepository = {
    createSession: (session) => {
      sessions.set(session.sessionId, session);
      return Promise.resolve();
    },
    getSession: (sessionId) => Promise.resolve(sessions.get(sessionId)),
    updateSessionStatus: (sessionId, status: ConversationStatus, at) => {
      const current = sessions.get(sessionId);
      if (current === undefined) return Promise.resolve(undefined);
      const updated = {
        ...current,
        status,
        lastActivityAt: at,
        ...(status === 'closed' ? { closedAt: at } : {}),
      };
      sessions.set(sessionId, updated);
      return Promise.resolve(updated);
    },
    appendTurn: (input) => {
      const turn = { ...input, sequence: turns.length + 1 };
      turns.push(turn);
      return Promise.resolve(turn);
    },
    findTurnByIdempotencyKey: (sessionId, key) =>
      Promise.resolve(
        turns.find((turn) => turn.sessionId === sessionId && turn.idempotencyKey === key),
      ),
    listTurns: (sessionId, limit) =>
      Promise.resolve(turns.filter((turn) => turn.sessionId === sessionId).slice(-limit)),
  };
  return new ConversationRuntime(
    repository,
    () => '00000000-0000-4000-8000-000000000001',
    () => new Date('2026-08-07T12:00:00.000Z'),
  );
};

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

describe('mobile voice client', () => {
  it('serves the WebRTC client without embedding credentials', async () => {
    const app = buildApi({ execute: () => Promise.resolve({ disposition: 'accepted' }) });
    const response = await app.inject({ method: 'GET', url: '/voice' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Start Conversation');
    expect(response.body).not.toContain('sk-');
    await app.close();
  });
});

describe('conversation runtime API', () => {
  it('starts, appends, and resumes a driving voice conversation', async () => {
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        conversation: {
          runtime: conversationRuntime(),
          principalId: 'peter',
          projectId: 'pendleton-os',
        },
      },
    );
    const auth = { authorization: `Bearer ${'a'.repeat(32)}` };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: auth,
      payload: { channel: 'voice', drivingMode: true },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json<{ sessionId: string }>().sessionId;
    const appended = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${sessionId}/turns`,
      headers: auth,
      payload: {
        role: 'user',
        kind: 'message',
        text: 'Good morning.',
        idempotencyKey: 'utterance-0001',
      },
    });
    expect(appended.statusCode).toBe(201);
    const resumed = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${sessionId}`,
      headers: auth,
    });
    expect(resumed.json()).toMatchObject({
      responseStyle: 'brief',
      turns: [{ text: 'Good morning.' }],
    });
    await app.close();
  });

  it('proxies an authenticated WebRTC offer without exposing the provider key', async () => {
    const connect = vi.fn().mockResolvedValue({
      sdp: 'answer-sdp',
      location: '/v1/realtime/calls/rtc_123',
    });
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        realtime: { service: { connect } as never, principalId: 'peter' },
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations/session-1/realtime',
      headers: {
        authorization: `Bearer ${'a'.repeat(32)}`,
        'content-type': 'application/sdp',
      },
      payload: 'v=0\r\na=ice-ufrag:long-enough',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('answer-sdp');
    expect(response.headers['x-pendleton-realtime-location']).toBe('/v1/realtime/calls/rtc_123');
    expect(connect).toHaveBeenCalledWith('session-1', 'peter', 'v=0\r\na=ice-ufrag:long-enough');
    await app.close();
  });
});
