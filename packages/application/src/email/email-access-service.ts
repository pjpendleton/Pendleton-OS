import type { EventRecorder } from '../events/event-recorder.js';
import type { ProjectRegistry } from '../project-registry/project-registry.js';

export type EmailProvider = 'gmail' | 'microsoft-graph';
export type EmailConnectorState = 'ready' | 'authorization_required' | 'unconfigured' | 'error';

export interface EmailConnectorStatus {
  readonly provider: EmailProvider;
  readonly state: EmailConnectorState;
  readonly permissionMode: 'read-only';
  readonly accountId?: string;
  readonly detail?: string;
}

export interface EmailAddress {
  readonly name?: string;
  readonly address: string;
}

export interface EmailMessageSummary {
  readonly provider: EmailProvider;
  readonly accountId: string;
  readonly messageId: string;
  readonly threadId?: string;
  readonly subject: string;
  readonly sender?: EmailAddress;
  readonly recipients: readonly EmailAddress[];
  readonly receivedAt?: string;
  readonly snippet: string;
  readonly hasAttachments?: boolean;
}

export interface ReadOnlyEmailClient {
  readonly provider: EmailProvider;
  status(): Promise<EmailConnectorStatus>;
  search(query: string, maxResults: number): Promise<readonly EmailMessageSummary[]>;
}

export interface EmailSearchRequest {
  readonly actorId: string;
  readonly projectId: string;
  readonly provider: EmailProvider;
  readonly query: string;
  readonly maxResults?: number;
}

export class EmailAccessService {
  readonly #clients: ReadonlyMap<EmailProvider, ReadOnlyEmailClient>;

  constructor(
    clients: readonly ReadOnlyEmailClient[],
    private readonly projects: ProjectRegistry,
    private readonly events: EventRecorder,
    private readonly createId: () => string,
    private readonly hashQuery: (value: string) => string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#clients = new Map(clients.map((client) => [client.provider, client]));
  }

  async statuses(): Promise<readonly EmailConnectorStatus[]> {
    return Promise.all(
      (['gmail', 'microsoft-graph'] as const).map(async (provider) => {
        const client = this.#clients.get(provider);
        return (
          (await client?.status()) ?? {
            provider,
            state: 'unconfigured',
            permissionMode: 'read-only',
          }
        );
      }),
    );
  }

  async search(request: EmailSearchRequest): Promise<readonly EmailMessageSummary[]> {
    const query = request.query.trim();
    if (query.length < 2 || query.length > 500) throw new Error('EMAIL_QUERY_INVALID');
    const maxResults = request.maxResults ?? 10;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 25)
      throw new Error('EMAIL_RESULT_LIMIT_INVALID');
    const project = await this.projects.findById(request.projectId);
    if (project === undefined) throw new Error('PROJECT_NOT_FOUND');
    if (project.status !== 'active') throw new Error('PROJECT_NOT_ACTIVE');
    if (!project.authorizedActorIds.includes(request.actorId))
      throw new Error('PROJECT_ACCESS_DENIED');
    const client = this.#clients.get(request.provider);
    if (client === undefined) throw new Error('EMAIL_CONNECTOR_UNCONFIGURED');
    const status = await client.status();
    if (status.state !== 'ready') throw new Error('EMAIL_CONNECTOR_AUTHORIZATION_REQUIRED');
    const messages = await client.search(query, maxResults);
    const at = this.now().toISOString();
    const correlationId = this.createId();
    await this.events.record({
      eventId: this.createId(),
      eventType: 'email.search.completed',
      eventVersion: 1,
      occurredAt: at,
      correlationId,
      actorId: request.actorId,
      projectId: request.projectId,
      payload: {
        provider: request.provider,
        accountId: status.accountId ?? 'unknown',
        permissionMode: 'read-only',
        querySha256: this.hashQuery(query),
        resultCount: messages.length,
      },
    });
    return messages;
  }
}
