import { describe, expect, it, vi } from 'vitest';
import { buildApi } from '../src/index.js';
import { DevicePairingService } from '../src/device-pairing.js';
import {
  ConversationRuntime,
  type EmailAccessService,
  type ConversationRepository,
  type ProjectKnowledgeService,
  type ProjectRecord,
  type ProjectRegistry,
} from '@pendleton-os/application';
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

const projectRegistry = () => {
  const record: ProjectRecord = {
    projectId: 'pendleton-os',
    displayName: 'Pendleton OS',
    aliases: ['os'],
    environment: 'production',
    status: 'active',
    authorizedActorIds: ['018f1f91-6f3d-7c16-bc61-55f9fa334f12'],
    resourceIds: ['drive:pendleton-os-root'],
  };
  const registry: ProjectRegistry = {
    findById: (projectId) => Promise.resolve(projectId === record.projectId ? record : undefined),
    findByAlias: (alias) => Promise.resolve(alias === 'os' ? [record] : []),
    list: (status) =>
      Promise.resolve(status === undefined || status === record.status ? [record] : []),
    getResources: () => Promise.resolve([]),
    importCandidates: (candidates) =>
      Promise.resolve(
        candidates.map((candidate) => ({
          projectId: candidate.projectId,
          displayName: candidate.displayName,
          aliases: candidate.aliases ?? [],
          environment: candidate.environment ?? 'production',
          status: 'candidate' as const,
          authorizedActorIds: [],
          resourceIds: candidate.resources?.map(({ resourceId }) => resourceId) ?? [],
        })),
      ),
    setStatus: (projectId, status) =>
      Promise.resolve(projectId === record.projectId ? { ...record, status } : undefined),
    findResource: () => Promise.resolve(undefined),
  };
  return registry;
};

describe('project registry API', () => {
  it('lists registered projects for an authenticated client', async () => {
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        projectRegistry: {
          registry: projectRegistry(),
          ownerActorId: '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
        },
      },
    );
    const response = await app.inject({
      method: 'GET',
      url: '/v1/projects?status=active',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projects: [{ projectId: 'pendleton-os', status: 'active' }],
    });
    await app.close();
  });

  it('imports bounded project candidates without activating them', async () => {
    const registry = projectRegistry();
    const importCandidates = vi.spyOn(registry, 'importCandidates');
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        projectRegistry: {
          registry,
          ownerActorId: '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
        },
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects/import',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
      payload: {
        candidates: [
          {
            projectId: 'parkco-purchase',
            displayName: 'Parkco Purchase',
            aliases: ['Parkco'],
            resources: [
              {
                provider: 'local-filesystem',
                resourceType: 'folder',
                externalId: 'D:\\Projects\\Parkco Purchase',
                displayName: 'Parkco Purchase local folder',
                metadata: { access: 'desktop-only' },
              },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      imported: 1,
      projects: [{ projectId: 'parkco-purchase', status: 'candidate' }],
    });
    expect(importCandidates).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          projectId: 'parkco-purchase',
          resources: [expect.objectContaining({ provider: 'local-filesystem' })],
        }),
      ],
      '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
    );
    await app.close();
  });

  it('requires administrator authentication for registry mutations', async () => {
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        projectRegistry: {
          registry: projectRegistry(),
          ownerActorId: '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
        },
      },
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/projects/pendleton-os',
          payload: { status: 'archived' },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });
});

describe('read-only email API', () => {
  it('reports connector state and performs an authenticated bounded search', async () => {
    const search = vi.fn().mockResolvedValue([
      {
        provider: 'gmail',
        accountId: 'owner@example.com',
        messageId: 'message-1',
        subject: 'Project update',
        recipients: [],
        snippet: 'Status',
      },
    ]);
    const service = {
      statuses: () =>
        Promise.resolve([
          {
            provider: 'gmail' as const,
            state: 'ready' as const,
            permissionMode: 'read-only' as const,
            accountId: 'owner@example.com',
          },
        ]),
      search,
    } as unknown as EmailAccessService;
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        email: {
          service,
          actorId: '00000000-0000-4000-8000-000000000001',
          defaultProjectId: 'pendleton-os',
        },
      },
    );
    const authorization = `Bearer ${'a'.repeat(32)}`;
    expect(
      (await app.inject({ method: 'GET', url: '/v1/email/connectors', headers: { authorization } }))
        .statusCode,
    ).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/email/search',
      headers: { authorization },
      payload: { provider: 'gmail', query: 'title report', maxResults: 5 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectId: 'pendleton-os',
      permissionMode: 'read-only',
      messages: [{ subject: 'Project update' }],
    });
    expect(search).toHaveBeenCalledWith({
      actorId: '00000000-0000-4000-8000-000000000001',
      projectId: 'pendleton-os',
      provider: 'gmail',
      query: 'title report',
      maxResults: 5,
    });
    await app.close();
  });

  it('does not expose connector status without authentication', async () => {
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        email: {
          service: { statuses: vi.fn(), search: vi.fn() } as unknown as EmailAccessService,
          actorId: '00000000-0000-4000-8000-000000000001',
          defaultProjectId: 'pendleton-os',
        },
      },
    );
    expect((await app.inject({ method: 'GET', url: '/v1/email/connectors' })).statusCode).toBe(401);
    await app.close();
  });
});

describe('project knowledge API', () => {
  it('performs an authenticated bounded search against the server-selected project', async () => {
    const search = vi.fn().mockResolvedValue({
      projectId: 'pendleton-os',
      permissionMode: 'read-only',
      items: [
        {
          provider: 'google-drive',
          kind: 'document',
          sourceId: 'doc-1',
          title: 'System Design',
          excerpt: 'Architecture',
          sourceLabel: 'Google Drive',
        },
      ],
      sources: [{ provider: 'google-drive', state: 'ready', resultCount: 1 }],
    });
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        knowledge: {
          service: { search } as unknown as ProjectKnowledgeService,
          actorId: '00000000-0000-4000-8000-000000000001',
          defaultProjectId: 'pendleton-os',
        },
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/search',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
      payload: { query: 'system architecture', maxResults: 5 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectId: 'pendleton-os',
      permissionMode: 'read-only',
      items: [{ title: 'System Design' }],
    });
    expect(search).toHaveBeenCalledWith({
      actorId: '00000000-0000-4000-8000-000000000001',
      projectId: 'pendleton-os',
      query: 'system architecture',
      maxResults: 5,
    });
    await app.close();
  });

  it('requires authentication before searching project knowledge', async () => {
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        knowledge: {
          service: { search: vi.fn() } as unknown as ProjectKnowledgeService,
          actorId: '00000000-0000-4000-8000-000000000001',
          defaultProjectId: 'pendleton-os',
        },
      },
    );
    expect(
      (await app.inject({ method: 'POST', url: '/v1/knowledge/search', payload: {} })).statusCode,
    ).toBe(401);
    await app.close();
  });
});

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
      actions: ['artifact.create', 'knowledge.search'],
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
    expect(response.body).toContain('/v1/auth/session');
    expect(response.body).not.toContain('API access token');
    expect(response.body).not.toContain('sk-');
    await app.close();
  });
});

describe('mobile device pairing', () => {
  it('serves passcode unlock without embedding the configured passcode', async () => {
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        devicePairing: {
          service: new DevicePairingService('a'.repeat(32), { passcode: '2468' }),
          publicOrigin: 'https://os.peterpendleton.com',
        },
      },
    );

    const page = await app.inject({ method: 'GET', url: '/pair' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Unlock Pendleton OS');
    expect(page.body).not.toContain('2468');

    const claimed = await app.inject({
      method: 'POST',
      url: '/v1/device-pairings/passcode',
      payload: { passcode: '2468' },
    });
    expect(claimed.statusCode).toBe(201);
    const cookie = String(claimed.headers['set-cookie']).split(';')[0];
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });

  it('rate limits invalid passcode attempts', async () => {
    const service = new DevicePairingService('a'.repeat(32), {
      passcode: '2468',
      pinMaxAttempts: 2,
    });
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        devicePairing: { service, publicOrigin: 'https://os.peterpendleton.com' },
      },
    );

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/device-pairings/passcode',
          payload: { passcode: '1111' },
        })
      ).statusCode,
    ).toBe(401);
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/device-pairings/passcode',
      payload: { passcode: '2222' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('900');
    await app.close();
  });

  it('creates a one-time QR pairing and authorizes the claimed device cookie', async () => {
    const service = new DevicePairingService('a'.repeat(32));
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        devicePairing: { service, publicOrigin: 'https://os.peterpendleton.com' },
      },
    );

    const created = await app.inject({
      method: 'POST',
      url: '/v1/device-pairings',
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
    });
    expect(created.statusCode).toBe(201);
    const pairing = created.json<{ claimUrl: string; qrCodeDataUrl: string }>();
    expect(pairing.claimUrl).toMatch(/^https:\/\/os\.peterpendleton\.com\/pair\/claim#token=/);
    expect(pairing.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

    const token = decodeURIComponent(pairing.claimUrl.split('#token=')[1] ?? '');
    const claimed = await app.inject({
      method: 'POST',
      url: '/v1/device-pairings/claim',
      payload: { token },
    });
    expect(claimed.statusCode).toBe(201);
    const cookie = String(claimed.headers['set-cookie']).split(';')[0];
    expect(claimed.headers['set-cookie']).toContain('HttpOnly');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/voice/capabilities',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/device-pairings/claim',
          payload: { token },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it('requires the administrator bearer token to create a pairing', async () => {
    const app = buildApi(
      { execute: () => Promise.resolve({ disposition: 'accepted' }) },
      {
        apiToken: 'a'.repeat(32),
        devicePairing: {
          service: new DevicePairingService('a'.repeat(32)),
          publicOrigin: 'https://os.peterpendleton.com',
        },
      },
    );
    expect((await app.inject({ method: 'POST', url: '/v1/device-pairings' })).statusCode).toBe(401);
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
