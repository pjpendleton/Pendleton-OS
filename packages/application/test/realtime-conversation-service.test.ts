import { describe, expect, it } from 'vitest';
import type {
  ConversationRuntime,
  ConversationSnapshot,
  RealtimeCallRequest,
} from '../src/index.js';
import { RealtimeConversationService } from '../src/index.js';

describe('RealtimeConversationService', () => {
  it('builds a server-controlled driving session with durable context and proposal-only tools', async () => {
    const snapshot: ConversationSnapshot = {
      session: {
        sessionId: 'session-1',
        contractVersion: '1.0.0',
        principalId: 'peter',
        projectId: 'pendleton-os',
        channel: 'voice',
        status: 'active',
        drivingMode: true,
        startedAt: '2026-08-07T12:00:00.000Z',
        lastActivityAt: '2026-08-07T12:00:00.000Z',
      },
      turns: [{ role: 'user', text: 'Review the title report.' }],
      responseStyle: 'brief',
    } as ConversationSnapshot;
    const conversations = {
      resume: () => Promise.resolve(snapshot),
      projectMemory: () =>
        Promise.resolve([{ text: 'Conversation recap: permit follow-up remains open.' }]),
    } as unknown as ConversationRuntime;
    let captured: RealtimeCallRequest | undefined;
    const service = new RealtimeConversationService(
      conversations,
      {
        createCall: (request) => {
          captured = request;
          return Promise.resolve({ sdp: 'answer-sdp' });
        },
      },
      {
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        transcriptionModel: 'gpt-live-transcribe',
      },
    );
    await expect(
      service.connect('session-1', 'peter', 'v=0\r\na=ice-ufrag:long-enough'),
    ).resolves.toEqual({ sdp: 'answer-sdp' });
    expect(captured?.safetyIdentifier).toMatch(/^[a-f0-9]{64}$/);
    expect(captured?.session.model).toBe('gpt-realtime-2.1');
    expect(captured?.session.audio).toEqual({
      input: { transcription: { model: 'gpt-live-transcribe' } },
      output: { voice: 'marin' },
    });
    expect(captured?.session.tools.map(({ name }) => name)).toEqual([
      'search_project_knowledge',
      'propose_artifact_create',
      'capture_follow_up',
      'select_project',
    ]);
    expect(captured?.session.instructions).toContain('Driving mode is active');
    expect(captured?.session.instructions).toContain('Use search_project_knowledge');
    expect(captured?.session.instructions).toContain('user: Review the title report.');
    expect(captured?.session.instructions).toContain('permit follow-up remains open');
  });
});
