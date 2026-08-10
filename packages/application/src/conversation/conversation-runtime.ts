import {
  CONVERSATION_CONTRACT_VERSION,
  type ConversationChannel,
  type ConversationRole,
  type ConversationSession,
  type ConversationStatus,
  type ConversationTurn,
  type ConversationTurnKind,
} from '@pendleton-os/contracts';

export interface ConversationRepository {
  createSession(session: ConversationSession): Promise<void>;
  getSession(sessionId: string): Promise<ConversationSession | undefined>;
  updateSessionStatus(
    sessionId: string,
    status: ConversationStatus,
    at: string,
  ): Promise<ConversationSession | undefined>;
  updateSessionProject(
    sessionId: string,
    projectId: string,
    at: string,
  ): Promise<ConversationSession | undefined>;
  appendTurn(input: Omit<ConversationTurn, 'sequence'>): Promise<ConversationTurn>;
  findTurnByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ConversationTurn | undefined>;
  listTurns(sessionId: string, limit: number): Promise<readonly ConversationTurn[]>;
  listProjectSummaries(
    principalId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ConversationTurn[]>;
}

export interface StartConversationRequest {
  readonly principalId: string;
  readonly projectId: string;
  readonly channel: ConversationChannel;
  readonly drivingMode: boolean;
}

export interface AppendConversationTurnRequest {
  readonly sessionId: string;
  readonly principalId: string;
  readonly role: ConversationRole;
  readonly kind: ConversationTurnKind;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly commandId?: string;
  readonly correlationId?: string;
}

export interface ConversationSnapshot {
  readonly session: ConversationSession;
  readonly turns: readonly ConversationTurn[];
  readonly responseStyle: 'brief' | 'standard';
}

export class ConversationRuntime {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly createId: () => string,
    private readonly now: () => Date,
  ) {}

  async start(request: StartConversationRequest): Promise<ConversationSession> {
    const at = this.now().toISOString();
    const session: ConversationSession = {
      sessionId: this.createId(),
      contractVersion: CONVERSATION_CONTRACT_VERSION,
      principalId: request.principalId,
      projectId: request.projectId,
      channel: request.channel,
      drivingMode: request.drivingMode,
      status: 'active',
      startedAt: at,
      lastActivityAt: at,
    };
    await this.repository.createSession(session);
    return session;
  }

  async append(request: AppendConversationTurnRequest): Promise<ConversationTurn> {
    const session = await this.requireOwnedSession(request.sessionId, request.principalId);
    if (session.status === 'closed') throw new Error('CONVERSATION_CLOSED');
    const text = request.text.trim();
    if (text.length === 0) throw new Error('CONVERSATION_TEXT_REQUIRED');
    const existing = await this.repository.findTurnByIdempotencyKey(
      request.sessionId,
      request.idempotencyKey,
    );
    if (existing !== undefined) return existing;
    return this.repository.appendTurn({
      turnId: this.createId(),
      sessionId: request.sessionId,
      role: request.role,
      kind: request.kind,
      text,
      idempotencyKey: request.idempotencyKey,
      ...(request.commandId === undefined ? {} : { commandId: request.commandId }),
      ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
      createdAt: this.now().toISOString(),
    });
  }

  async resume(sessionId: string, principalId: string, limit = 50): Promise<ConversationSnapshot> {
    const session = await this.requireOwnedSession(sessionId, principalId);
    return {
      session,
      turns: await this.repository.listTurns(sessionId, Math.min(Math.max(limit, 1), 100)),
      responseStyle: session.drivingMode ? 'brief' : 'standard',
    };
  }

  async close(sessionId: string, principalId: string): Promise<ConversationSession> {
    const session = await this.requireOwnedSession(sessionId, principalId);
    if (session.status === 'closed') return session;
    const turns = await this.repository.listTurns(sessionId, 50);
    const recap = this.buildRecap(turns);
    if (recap.length > 0) {
      await this.append({
        sessionId,
        principalId,
        role: 'system',
        kind: 'summary',
        text: recap,
        idempotencyKey: `session-summary:${sessionId}`,
      });
    }
    const updated = await this.repository.updateSessionStatus(
      sessionId,
      'closed',
      this.now().toISOString(),
    );
    if (updated === undefined) throw new Error('CONVERSATION_NOT_FOUND');
    return updated;
  }

  async switchProject(
    sessionId: string,
    principalId: string,
    projectId: string,
  ): Promise<ConversationSession> {
    const session = await this.requireOwnedSession(sessionId, principalId);
    if (session.status === 'closed') throw new Error('CONVERSATION_CLOSED');
    const normalizedProjectId = projectId.trim();
    if (normalizedProjectId.length === 0) throw new Error('PROJECT_SELECTOR_INVALID');
    const updated = await this.repository.updateSessionProject(
      sessionId,
      normalizedProjectId,
      this.now().toISOString(),
    );
    if (updated === undefined) throw new Error('CONVERSATION_NOT_FOUND');
    return updated;
  }

  async projectMemory(
    principalId: string,
    projectId: string,
    limit = 5,
  ): Promise<readonly ConversationTurn[]> {
    return this.repository.listProjectSummaries(
      principalId,
      projectId,
      Math.min(Math.max(limit, 1), 10),
    );
  }

  private buildRecap(turns: readonly ConversationTurn[]): string {
    const labels: Readonly<Record<ConversationRole, string>> = {
      user: 'Peter',
      assistant: 'Pendleton OS',
      system: 'System',
      tool: 'Action',
    };
    const lines = turns
      .filter((turn) => turn.kind !== 'summary')
      .slice(-12)
      .map((turn) => {
        const compact = turn.text.replace(/\s+/g, ' ').trim();
        return `- ${labels[turn.role]}: ${compact.slice(0, 400)}`;
      });
    return lines.length === 0 ? '' : `Conversation recap:\n${lines.join('\n')}`.slice(0, 5_000);
  }

  private async requireOwnedSession(
    sessionId: string,
    principalId: string,
  ): Promise<ConversationSession> {
    const session = await this.repository.getSession(sessionId);
    if (session === undefined) throw new Error('CONVERSATION_NOT_FOUND');
    if (session.principalId !== principalId) throw new Error('CONVERSATION_ACCESS_DENIED');
    return session;
  }
}
