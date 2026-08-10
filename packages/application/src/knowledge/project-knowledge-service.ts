import type { EmailAccessService, EmailProvider } from '../email/email-access-service.js';
import type { EventRecorder } from '../events/event-recorder.js';
import type { ProjectRegistry } from '../project-registry/project-registry.js';

export type ProjectKnowledgeProvider = 'google-drive' | EmailProvider;

export interface ProjectKnowledgeItem {
  readonly provider: ProjectKnowledgeProvider;
  readonly kind: 'document' | 'email';
  readonly sourceId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly sourceLabel: string;
  readonly canonicalUrl?: string;
  readonly sender?: string;
  readonly occurredAt?: string;
}

export interface ProjectDocumentKnowledgeSource {
  search(
    projectId: string,
    query: string,
    maxResults: number,
  ): Promise<readonly ProjectKnowledgeItem[]>;
}

export interface ProjectKnowledgeSearchRequest {
  readonly actorId: string;
  readonly projectId: string;
  readonly query: string;
  readonly maxResults?: number;
}

export interface ProjectKnowledgeSourceStatus {
  readonly provider: ProjectKnowledgeProvider;
  readonly state: 'ready' | 'unavailable';
  readonly resultCount: number;
  readonly detail?: string;
}

export interface ProjectKnowledgeSearchResult {
  readonly projectId: string;
  readonly permissionMode: 'read-only';
  readonly items: readonly ProjectKnowledgeItem[];
  readonly sources: readonly ProjectKnowledgeSourceStatus[];
}

const errorCode = (error: unknown): string =>
  error instanceof Error && /^[A-Z0-9_:.-]+$/.test(error.message)
    ? error.message.slice(0, 120)
    : 'KNOWLEDGE_SOURCE_UNAVAILABLE';

const roundRobin = (
  buckets: readonly (readonly ProjectKnowledgeItem[])[],
  limit: number,
): readonly ProjectKnowledgeItem[] => {
  const items: ProjectKnowledgeItem[] = [];
  for (let offset = 0; items.length < limit; offset += 1) {
    let found = false;
    for (const bucket of buckets) {
      const item = bucket[offset];
      if (item === undefined) continue;
      items.push(item);
      found = true;
      if (items.length === limit) break;
    }
    if (!found) break;
  }
  return items;
};

export class ProjectKnowledgeService {
  constructor(
    private readonly dependencies: {
      readonly projects: ProjectRegistry;
      readonly documents: ProjectDocumentKnowledgeSource;
      readonly email: EmailAccessService;
      readonly events: EventRecorder;
      readonly createId: () => string;
      readonly hashQuery: (value: string) => string;
      readonly now?: () => Date;
    },
  ) {}

  async search(request: ProjectKnowledgeSearchRequest): Promise<ProjectKnowledgeSearchResult> {
    const query = request.query.trim();
    if (query.length < 2 || query.length > 300) throw new Error('KNOWLEDGE_QUERY_INVALID');
    const maxResults = request.maxResults ?? 8;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 12)
      throw new Error('KNOWLEDGE_RESULT_LIMIT_INVALID');

    const project = await this.dependencies.projects.findById(request.projectId);
    if (project === undefined) throw new Error('PROJECT_NOT_FOUND');
    if (project.status !== 'active') throw new Error('PROJECT_NOT_ACTIVE');
    if (!project.authorizedActorIds.includes(request.actorId))
      throw new Error('PROJECT_ACCESS_DENIED');

    const providers: readonly ProjectKnowledgeProvider[] = [
      'google-drive',
      'gmail',
      'microsoft-graph',
    ];
    const searches = [
      () => this.dependencies.documents.search(request.projectId, query, maxResults),
      () => this.searchEmail('gmail', request, query, maxResults),
      () => this.searchEmail('microsoft-graph', request, query, maxResults),
    ];
    const settled = await Promise.allSettled(searches.map((search) => search()));
    const buckets = settled.map((result) => (result.status === 'fulfilled' ? result.value : []));
    const sources = settled.map<ProjectKnowledgeSourceStatus>((result, index) => ({
      provider: providers[index] ?? 'google-drive',
      state: result.status === 'fulfilled' ? 'ready' : 'unavailable',
      resultCount: result.status === 'fulfilled' ? result.value.length : 0,
      ...(result.status === 'rejected' ? { detail: errorCode(result.reason) } : {}),
    }));
    const items = roundRobin(buckets, maxResults);
    const at = (this.dependencies.now ?? (() => new Date()))().toISOString();
    const correlationId = this.dependencies.createId();
    await this.dependencies.events.record({
      eventId: this.dependencies.createId(),
      eventType: 'knowledge.search.completed',
      eventVersion: 1,
      occurredAt: at,
      correlationId,
      actorId: request.actorId,
      projectId: request.projectId,
      payload: {
        permissionMode: 'read-only',
        querySha256: this.dependencies.hashQuery(query),
        resultCount: items.length,
        providers: sources.map(({ provider, state, resultCount, detail }) => ({
          provider,
          state,
          resultCount,
          ...(detail === undefined ? {} : { detail }),
        })),
      },
    });
    return { projectId: request.projectId, permissionMode: 'read-only', items, sources };
  }

  private async searchEmail(
    provider: EmailProvider,
    request: ProjectKnowledgeSearchRequest,
    query: string,
    maxResults: number,
  ): Promise<readonly ProjectKnowledgeItem[]> {
    const messages = await this.dependencies.email.search({
      actorId: request.actorId,
      projectId: request.projectId,
      provider,
      query,
      maxResults,
    });
    return messages.map((message) => ({
      provider,
      kind: 'email',
      sourceId: message.messageId,
      title: message.subject,
      excerpt: message.snippet.slice(0, 1_200),
      sourceLabel: provider === 'gmail' ? 'Gmail' : 'Outlook',
      ...(message.sender === undefined ? {} : { sender: message.sender.address }),
      ...(message.receivedAt === undefined ? {} : { occurredAt: message.receivedAt }),
    }));
  }
}
