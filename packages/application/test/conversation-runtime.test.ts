import { describe, expect, it } from 'vitest';
import { ConversationRuntime, type ConversationRepository } from '../src/index.js';
import type {
  ConversationSession,
  ConversationStatus,
  ConversationTurn,
} from '@pendleton-os/contracts';

class MemoryConversations implements ConversationRepository {
  readonly sessions = new Map<string, ConversationSession>();
  readonly turns: ConversationTurn[] = [];

  createSession(session: ConversationSession): Promise<void> {
    this.sessions.set(session.sessionId, session);
    return Promise.resolve();
  }
  getSession(sessionId: string): Promise<ConversationSession | undefined> {
    return Promise.resolve(this.sessions.get(sessionId));
  }
  updateSessionStatus(
    sessionId: string,
    status: ConversationStatus,
    at: string,
  ): Promise<ConversationSession | undefined> {
    const current = this.sessions.get(sessionId);
    if (current === undefined) return Promise.resolve(undefined);
    const updated: ConversationSession = {
      ...current,
      status,
      lastActivityAt: at,
      ...(status === 'closed' ? { closedAt: at } : {}),
    };
    this.sessions.set(sessionId, updated);
    return Promise.resolve(updated);
  }
  appendTurn(input: Omit<ConversationTurn, 'sequence'>): Promise<ConversationTurn> {
    const turn = { ...input, sequence: this.turns.length + 1 };
    this.turns.push(turn);
    return Promise.resolve(turn);
  }
  findTurnByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ConversationTurn | undefined> {
    return Promise.resolve(
      this.turns.find(
        (turn) => turn.sessionId === sessionId && turn.idempotencyKey === idempotencyKey,
      ),
    );
  }
  listTurns(sessionId: string, limit: number): Promise<readonly ConversationTurn[]> {
    return Promise.resolve(this.turns.filter((turn) => turn.sessionId === sessionId).slice(-limit));
  }
}

describe('ConversationRuntime', () => {
  it('persists and resumes a driving conversation with brief response style', async () => {
    const repository = new MemoryConversations();
    let id = 0;
    const runtime = new ConversationRuntime(
      repository,
      () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      () => new Date('2026-08-07T12:00:00.000Z'),
    );
    const session = await runtime.start({
      principalId: 'peter',
      projectId: 'pendleton-os',
      channel: 'voice',
      drivingMode: true,
    });
    const first = await runtime.append({
      sessionId: session.sessionId,
      principalId: 'peter',
      role: 'user',
      kind: 'message',
      text: ' What changed overnight? ',
      idempotencyKey: 'utterance-0001',
    });
    const duplicate = await runtime.append({
      sessionId: session.sessionId,
      principalId: 'peter',
      role: 'user',
      kind: 'message',
      text: 'ignored duplicate',
      idempotencyKey: 'utterance-0001',
    });
    expect(duplicate.turnId).toBe(first.turnId);
    expect((await runtime.resume(session.sessionId, 'peter')).responseStyle).toBe('brief');
    expect(repository.turns).toHaveLength(1);
    expect(repository.turns[0]?.text).toBe('What changed overnight?');
  });

  it('prevents cross-principal access and appending after close', async () => {
    const repository = new MemoryConversations();
    const runtime = new ConversationRuntime(
      repository,
      () => '00000000-0000-4000-8000-000000000001',
      () => new Date('2026-08-07T12:00:00.000Z'),
    );
    const session = await runtime.start({
      principalId: 'peter',
      projectId: 'pendleton-os',
      channel: 'mobile',
      drivingMode: false,
    });
    await expect(runtime.resume(session.sessionId, 'someone-else')).rejects.toThrow(
      'CONVERSATION_ACCESS_DENIED',
    );
    await runtime.close(session.sessionId, 'peter');
    await expect(
      runtime.append({
        sessionId: session.sessionId,
        principalId: 'peter',
        role: 'user',
        kind: 'message',
        text: 'continue',
        idempotencyKey: 'utterance-0002',
      }),
    ).rejects.toThrow('CONVERSATION_CLOSED');
  });
});
