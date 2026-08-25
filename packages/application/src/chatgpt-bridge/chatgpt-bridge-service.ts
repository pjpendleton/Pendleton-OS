import type { EventRecorder } from '../events/event-recorder.js';

export const CHATGPT_BRIDGE_CONTRACT_VERSION = '1.0.0' as const;

export type ChatGptInventoryScope = 'project-list' | 'project-detail';
export type ChatGptLocatorKind = 'provider-id' | 'derived-name';
export type ChatGptContentAccess = 'available' | 'metadata-only' | 'unknown';
export type ChatGptObservationStatus = 'active' | 'stale';

export interface ChatGptConversationObservationInput {
  readonly sourceConversationKey: string;
  readonly title: string;
  readonly canonicalUrl?: string;
  readonly modifiedLabel?: string;
}

export interface ChatGptSourceObservationInput {
  readonly sourceKey: string;
  readonly displayName: string;
  readonly mediaType?: string;
  readonly detailLabel?: string;
  readonly contentAccess: ChatGptContentAccess;
}

export interface ChatGptProjectObservationInput {
  readonly sourceProjectKey: string;
  readonly locatorKind: ChatGptLocatorKind;
  readonly displayName: string;
  readonly canonicalUrl?: string;
  readonly modifiedLabel?: string;
  readonly conversations: readonly ChatGptConversationObservationInput[];
  readonly sources: readonly ChatGptSourceObservationInput[];
}

export interface ChatGptInventoryInput {
  readonly contractVersion: typeof CHATGPT_BRIDGE_CONTRACT_VERSION;
  readonly snapshotKey: string;
  readonly scope: ChatGptInventoryScope;
  readonly observedCollections: readonly ('projects' | 'conversations' | 'sources')[];
  readonly collectorVersion: string;
  readonly capturedAt: string;
  readonly workspaceLabel: string;
  readonly pageUrl: string;
  readonly projects: readonly ChatGptProjectObservationInput[];
}

export interface ChatGptInventoryReceipt {
  readonly snapshotId: string;
  readonly replayed: boolean;
  readonly receivedAt: string;
  readonly projectCount: number;
  readonly conversationCount: number;
  readonly sourceCount: number;
}

export interface ChatGptConversationObservation extends ChatGptConversationObservationInput {
  readonly status: ChatGptObservationStatus;
  readonly lastObservedAt: string;
}

export interface ChatGptSourceObservation extends ChatGptSourceObservationInput {
  readonly status: ChatGptObservationStatus;
  readonly lastObservedAt: string;
}

export interface ChatGptProjectObservation {
  readonly sourceProjectKey: string;
  readonly locatorKind: ChatGptLocatorKind;
  readonly displayName: string;
  readonly canonicalUrl?: string;
  readonly modifiedLabel?: string;
  readonly workspaceLabel: string;
  readonly collectorVersion: string;
  readonly status: ChatGptObservationStatus;
  readonly lastObservedAt: string;
  readonly conversationCount: number;
  readonly sourceCount: number;
  readonly conversations?: readonly ChatGptConversationObservation[];
  readonly sources?: readonly ChatGptSourceObservation[];
}

export interface ChatGptBridgeRepository {
  persistInventory(
    snapshotId: string,
    input: ChatGptInventoryInput,
    receivedAt: string,
  ): Promise<ChatGptInventoryReceipt>;
  listProjects(): Promise<readonly ChatGptProjectObservation[]>;
  findProject(sourceProjectKey: string): Promise<ChatGptProjectObservation | undefined>;
}

export class ChatGptBridgeService {
  constructor(
    private readonly repository: ChatGptBridgeRepository,
    private readonly events: EventRecorder,
    private readonly createId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ingest(input: ChatGptInventoryInput, actorId: string): Promise<ChatGptInventoryReceipt> {
    const receivedAt = this.now().toISOString();
    const receipt = await this.repository.persistInventory(
      `chatgpt-snapshot:${this.createId()}`,
      input,
      receivedAt,
    );
    await this.events.record({
      eventId: `event:${this.createId()}`,
      eventType: 'connector.chatgpt.inventory.accepted',
      eventVersion: 1,
      occurredAt: receivedAt,
      correlationId: receipt.snapshotId,
      actorId,
      payload: {
        snapshotId: receipt.snapshotId,
        replayed: receipt.replayed,
        scope: input.scope,
        workspaceLabel: input.workspaceLabel,
        collectorVersion: input.collectorVersion,
        projectCount: receipt.projectCount,
        conversationCount: receipt.conversationCount,
        sourceCount: receipt.sourceCount,
      },
    });
    return receipt;
  }

  listProjects(): Promise<readonly ChatGptProjectObservation[]> {
    return this.repository.listProjects();
  }

  findProject(sourceProjectKey: string): Promise<ChatGptProjectObservation | undefined> {
    return this.repository.findProject(sourceProjectKey);
  }
}
