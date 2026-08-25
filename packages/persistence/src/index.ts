import pg from 'pg';
import type {
  ChatGptBridgeRepository,
  ChatGptConversationObservation,
  ChatGptInventoryInput,
  ChatGptInventoryReceipt,
  ChatGptProjectObservation,
  ChatGptSourceObservation,
  ConversationRepository,
  EventEnvelope,
  EventStore,
  IdempotencyRegistry,
  ProjectCandidateInput,
  ProjectRecord,
  ProjectRegistry,
  ProjectResourceProvider,
  ProjectResourceRecord,
  ProjectResourceType,
  ProjectStatus,
  ReservationRequest,
  ReservationResult,
  WorkflowInstance,
  WorkflowRepository,
} from '@pendleton-os/application';
import type { Environment } from '@pendleton-os/contracts';
import type {
  ConversationSession,
  ConversationStatus,
  ConversationTurn,
} from '@pendleton-os/contracts';

const { Pool } = pg;

export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  connect?(): Promise<SqlTransactionClient>;
}

export interface SqlTransactionClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
}

export const createPostgresPool = (connectionString: string): pg.Pool => {
  if (
    !connectionString.startsWith('postgresql://') &&
    !connectionString.startsWith('postgres://')
  ) {
    throw new Error('DATABASE_URL_INVALID');
  }
  return new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 5 });
};

interface ChatGptProjectRow extends Record<string, unknown> {
  workspace_label: string;
  source_project_key: string;
  locator_kind: 'provider-id' | 'derived-name';
  display_name: string;
  canonical_url: string | null;
  modified_label: string | null;
  collector_version: string;
  status: 'active' | 'stale';
  last_observed_at: Date;
  conversation_count: number;
  source_count: number;
}

const mapChatGptProject = (row: ChatGptProjectRow): ChatGptProjectObservation => ({
  sourceProjectKey: row.source_project_key,
  locatorKind: row.locator_kind,
  displayName: row.display_name,
  ...(row.canonical_url === null ? {} : { canonicalUrl: row.canonical_url }),
  ...(row.modified_label === null ? {} : { modifiedLabel: row.modified_label }),
  workspaceLabel: row.workspace_label,
  collectorVersion: row.collector_version,
  status: row.status,
  lastObservedAt: row.last_observed_at.toISOString(),
  conversationCount: row.conversation_count,
  sourceCount: row.source_count,
});

export class PostgresChatGptBridgeRepository implements ChatGptBridgeRepository {
  constructor(private readonly client: SqlClient) {}

  async persistInventory(
    snapshotId: string,
    input: ChatGptInventoryInput,
    receivedAt: string,
  ): Promise<ChatGptInventoryReceipt> {
    if (this.client.connect === undefined) {
      return this.persistInventoryDirect(snapshotId, input, receivedAt);
    }
    const connection = await this.client.connect();
    try {
      await connection.query('BEGIN');
      const receipt = await new PostgresChatGptBridgeRepository(connection).persistInventoryDirect(
        snapshotId,
        input,
        receivedAt,
      );
      await connection.query('COMMIT');
      return receipt;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  private async persistInventoryDirect(
    snapshotId: string,
    input: ChatGptInventoryInput,
    receivedAt: string,
  ): Promise<ChatGptInventoryReceipt> {
    const conversationCount = input.projects.reduce(
      (count, project) => count + project.conversations.length,
      0,
    );
    const sourceCount = input.projects.reduce(
      (count, project) => count + project.sources.length,
      0,
    );
    const snapshot = await this.client.query<{
      snapshot_id: string;
      received_at: Date;
      inserted: boolean;
    }>(
      `INSERT INTO chatgpt_inventory_snapshots
        (snapshot_id,snapshot_key,scope,observed_collections,collector_version,captured_at,
         received_at,workspace_label,page_url,project_count,conversation_count,source_count)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (workspace_label,snapshot_key) DO UPDATE
       SET snapshot_key=EXCLUDED.snapshot_key
       RETURNING snapshot_id,received_at,(xmax=0) AS inserted`,
      [
        snapshotId,
        input.snapshotKey,
        input.scope,
        JSON.stringify(input.observedCollections),
        input.collectorVersion,
        input.capturedAt,
        receivedAt,
        input.workspaceLabel,
        input.pageUrl,
        input.projects.length,
        conversationCount,
        sourceCount,
      ],
    );
    const persistedSnapshot = snapshot.rows[0];
    if (persistedSnapshot === undefined) throw new Error('CHATGPT_SNAPSHOT_PERSIST_FAILED');
    if (!persistedSnapshot.inserted) {
      return {
        snapshotId: persistedSnapshot.snapshot_id,
        replayed: true,
        receivedAt: persistedSnapshot.received_at.toISOString(),
        projectCount: input.projects.length,
        conversationCount,
        sourceCount,
      };
    }

    for (const project of input.projects) {
      await this.client.query(
        `INSERT INTO chatgpt_projects
          (workspace_label,source_project_key,locator_kind,display_name,canonical_url,
           modified_label,collector_version,status,first_observed_at,last_observed_at,last_snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$8,$9)
         ON CONFLICT (workspace_label,source_project_key) DO UPDATE SET
           locator_kind=EXCLUDED.locator_kind,display_name=EXCLUDED.display_name,
           canonical_url=EXCLUDED.canonical_url,modified_label=EXCLUDED.modified_label,
           collector_version=EXCLUDED.collector_version,status='active',
           last_observed_at=EXCLUDED.last_observed_at,last_snapshot_id=EXCLUDED.last_snapshot_id`,
        [
          input.workspaceLabel,
          project.sourceProjectKey,
          project.locatorKind,
          project.displayName,
          project.canonicalUrl ?? null,
          project.modifiedLabel ?? null,
          input.collectorVersion,
          input.capturedAt,
          persistedSnapshot.snapshot_id,
        ],
      );
      for (const conversation of project.conversations) {
        await this.client.query(
          `INSERT INTO chatgpt_conversations
            (workspace_label,source_project_key,source_conversation_key,title,canonical_url,
             modified_label,status,first_observed_at,last_observed_at,last_snapshot_id)
           VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$7,$8)
           ON CONFLICT (workspace_label,source_project_key,source_conversation_key) DO UPDATE SET
             title=EXCLUDED.title,canonical_url=EXCLUDED.canonical_url,
             modified_label=EXCLUDED.modified_label,status='active',
             last_observed_at=EXCLUDED.last_observed_at,last_snapshot_id=EXCLUDED.last_snapshot_id`,
          [
            input.workspaceLabel,
            project.sourceProjectKey,
            conversation.sourceConversationKey,
            conversation.title,
            conversation.canonicalUrl ?? null,
            conversation.modifiedLabel ?? null,
            input.capturedAt,
            persistedSnapshot.snapshot_id,
          ],
        );
      }
      for (const source of project.sources) {
        await this.client.query(
          `INSERT INTO chatgpt_sources
            (workspace_label,source_project_key,source_key,display_name,media_type,detail_label,
             content_access,status,first_observed_at,last_observed_at,last_snapshot_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$8,$9)
           ON CONFLICT (workspace_label,source_project_key,source_key) DO UPDATE SET
             display_name=EXCLUDED.display_name,media_type=EXCLUDED.media_type,
             detail_label=EXCLUDED.detail_label,content_access=EXCLUDED.content_access,status='active',
             last_observed_at=EXCLUDED.last_observed_at,last_snapshot_id=EXCLUDED.last_snapshot_id`,
          [
            input.workspaceLabel,
            project.sourceProjectKey,
            source.sourceKey,
            source.displayName,
            source.mediaType ?? null,
            source.detailLabel ?? null,
            source.contentAccess,
            input.capturedAt,
            persistedSnapshot.snapshot_id,
          ],
        );
      }
    }

    if (input.scope === 'project-list' && input.observedCollections.includes('projects')) {
      await this.client.query(
        `UPDATE chatgpt_projects SET status='stale'
         WHERE workspace_label=$1 AND NOT (source_project_key = ANY($2::text[]))`,
        [input.workspaceLabel, input.projects.map(({ sourceProjectKey }) => sourceProjectKey)],
      );
    }
    if (input.scope === 'project-detail') {
      const project = input.projects[0];
      if (project !== undefined && input.observedCollections.includes('conversations')) {
        await this.client.query(
          `UPDATE chatgpt_conversations SET status='stale'
           WHERE workspace_label=$1 AND source_project_key=$2
             AND NOT (source_conversation_key = ANY($3::text[]))`,
          [
            input.workspaceLabel,
            project.sourceProjectKey,
            project.conversations.map(({ sourceConversationKey }) => sourceConversationKey),
          ],
        );
      }
      if (project !== undefined && input.observedCollections.includes('sources')) {
        await this.client.query(
          `UPDATE chatgpt_sources SET status='stale'
           WHERE workspace_label=$1 AND source_project_key=$2
             AND NOT (source_key = ANY($3::text[]))`,
          [
            input.workspaceLabel,
            project.sourceProjectKey,
            project.sources.map(({ sourceKey }) => sourceKey),
          ],
        );
      }
    }
    return {
      snapshotId: persistedSnapshot.snapshot_id,
      replayed: false,
      receivedAt: persistedSnapshot.received_at.toISOString(),
      projectCount: input.projects.length,
      conversationCount,
      sourceCount,
    };
  }

  async listProjects(): Promise<readonly ChatGptProjectObservation[]> {
    const result = await this.client.query<ChatGptProjectRow>(
      `SELECT p.*,
        (SELECT count(*)::int FROM chatgpt_conversations c
         WHERE c.workspace_label=p.workspace_label AND c.source_project_key=p.source_project_key
           AND c.status='active') AS conversation_count,
        (SELECT count(*)::int FROM chatgpt_sources s
         WHERE s.workspace_label=p.workspace_label AND s.source_project_key=p.source_project_key
           AND s.status='active') AS source_count
       FROM chatgpt_projects p ORDER BY p.display_name,p.source_project_key`,
    );
    return result.rows.map(mapChatGptProject);
  }

  async findProject(sourceProjectKey: string): Promise<ChatGptProjectObservation | undefined> {
    const result = await this.client.query<ChatGptProjectRow>(
      `SELECT p.*,
        (SELECT count(*)::int FROM chatgpt_conversations c
         WHERE c.workspace_label=p.workspace_label AND c.source_project_key=p.source_project_key
           AND c.status='active') AS conversation_count,
        (SELECT count(*)::int FROM chatgpt_sources s
         WHERE s.workspace_label=p.workspace_label AND s.source_project_key=p.source_project_key
           AND s.status='active') AS source_count
       FROM chatgpt_projects p WHERE p.source_project_key=$1
       ORDER BY p.last_observed_at DESC LIMIT 1`,
      [sourceProjectKey],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const [conversations, sources] = await Promise.all([
      this.client.query<{
        source_conversation_key: string;
        title: string;
        canonical_url: string | null;
        modified_label: string | null;
        status: 'active' | 'stale';
        last_observed_at: Date;
      }>(
        `SELECT source_conversation_key,title,canonical_url,modified_label,status,last_observed_at
         FROM chatgpt_conversations WHERE workspace_label=$1 AND source_project_key=$2
         ORDER BY status,title,source_conversation_key`,
        [row.workspace_label, row.source_project_key],
      ),
      this.client.query<{
        source_key: string;
        display_name: string;
        media_type: string | null;
        detail_label: string | null;
        content_access: 'available' | 'metadata-only' | 'unknown';
        status: 'active' | 'stale';
        last_observed_at: Date;
      }>(
        `SELECT source_key,display_name,media_type,detail_label,content_access,status,last_observed_at
         FROM chatgpt_sources WHERE workspace_label=$1 AND source_project_key=$2
         ORDER BY status,display_name,source_key`,
        [row.workspace_label, row.source_project_key],
      ),
    ]);
    return {
      ...mapChatGptProject(row),
      conversations: conversations.rows.map(
        (conversation): ChatGptConversationObservation => ({
          sourceConversationKey: conversation.source_conversation_key,
          title: conversation.title,
          ...(conversation.canonical_url === null
            ? {}
            : { canonicalUrl: conversation.canonical_url }),
          ...(conversation.modified_label === null
            ? {}
            : { modifiedLabel: conversation.modified_label }),
          status: conversation.status,
          lastObservedAt: conversation.last_observed_at.toISOString(),
        }),
      ),
      sources: sources.rows.map(
        (source): ChatGptSourceObservation => ({
          sourceKey: source.source_key,
          displayName: source.display_name,
          ...(source.media_type === null ? {} : { mediaType: source.media_type }),
          ...(source.detail_label === null ? {} : { detailLabel: source.detail_label }),
          contentAccess: source.content_access,
          status: source.status,
          lastObservedAt: source.last_observed_at.toISOString(),
        }),
      ),
    };
  }
}

interface ProjectRow extends Record<string, unknown> {
  project_id: string;
  display_name: string;
  description: string | null;
  environment: Environment;
  status: ProjectStatus;
}

interface ProjectResourceRow extends Record<string, unknown> {
  resource_id: string;
  project_id: string;
  provider: ProjectResourceProvider;
  resource_type: ProjectResourceType;
  external_id: string;
  display_name: string;
  canonical_url: string | null;
  status: 'active' | 'disconnected';
  metadata: Record<string, unknown>;
  discovered_at: Date;
  updated_at: Date;
}

const mapResource = (row: ProjectResourceRow): ProjectResourceRecord => ({
  resourceId: row.resource_id,
  projectId: row.project_id,
  provider: row.provider,
  resourceType: row.resource_type,
  externalId: row.external_id,
  displayName: row.display_name,
  ...(row.canonical_url === null ? {} : { canonicalUrl: row.canonical_url }),
  status: row.status,
  metadata: row.metadata,
  discoveredAt: row.discovered_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class PostgresProjectRegistry implements ProjectRegistry {
  constructor(private readonly client: SqlClient) {}

  async findById(projectId: string): Promise<ProjectRecord | undefined> {
    const result = await this.client.query<ProjectRow>(
      `SELECT project_id,display_name,description,environment,status
       FROM projects WHERE project_id=$1`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const [aliases, members, resources] = await Promise.all([
      this.client.query<{ alias: string }>(
        'SELECT alias FROM project_aliases WHERE project_id=$1 ORDER BY alias',
        [projectId],
      ),
      this.client.query<{ actor_id: string }>(
        `SELECT actor_id FROM project_members
         WHERE project_id=$1 AND status='active' ORDER BY actor_id`,
        [projectId],
      ),
      this.client.query<{ resource_id: string }>(
        `SELECT resource_id FROM project_resources
         WHERE project_id=$1 AND status='active' ORDER BY resource_id`,
        [projectId],
      ),
    ]);
    return {
      projectId: row.project_id,
      displayName: row.display_name,
      ...(row.description === null ? {} : { description: row.description }),
      aliases: aliases.rows.map(({ alias }) => alias),
      environment: row.environment,
      status: row.status,
      authorizedActorIds: members.rows.map(({ actor_id }) => actor_id),
      resourceIds: resources.rows.map(({ resource_id }) => resource_id),
    };
  }

  async findByAlias(alias: string): Promise<readonly ProjectRecord[]> {
    const result = await this.client.query<{ project_id: string }>(
      `SELECT DISTINCT project_id FROM project_aliases
       WHERE lower(btrim(alias))=lower(btrim($1)) ORDER BY project_id`,
      [alias],
    );
    const projects = await Promise.all(
      result.rows.map(({ project_id }) => this.findById(project_id)),
    );
    return projects.filter((project): project is ProjectRecord => project !== undefined);
  }

  async list(status?: ProjectStatus): Promise<readonly ProjectRecord[]> {
    const result = await this.client.query<{ project_id: string }>(
      status === undefined
        ? 'SELECT project_id FROM projects ORDER BY display_name,project_id'
        : 'SELECT project_id FROM projects WHERE status=$1 ORDER BY display_name,project_id',
      status === undefined ? [] : [status],
    );
    const projects = await Promise.all(
      result.rows.map(({ project_id }) => this.findById(project_id)),
    );
    return projects.filter((project): project is ProjectRecord => project !== undefined);
  }

  async getResources(projectId: string): Promise<readonly ProjectResourceRecord[]> {
    const result = await this.client.query<ProjectResourceRow>(
      `SELECT resource_id,project_id,provider,resource_type,external_id,display_name,
              canonical_url,status,metadata,discovered_at,updated_at
       FROM project_resources WHERE project_id=$1 ORDER BY provider,display_name,resource_id`,
      [projectId],
    );
    return result.rows.map(mapResource);
  }

  async importCandidates(
    candidates: readonly ProjectCandidateInput[],
    ownerActorId: string,
  ): Promise<readonly ProjectRecord[]> {
    const imported: ProjectRecord[] = [];
    for (const candidate of candidates) {
      const now = new Date().toISOString();
      await this.client.query(
        `INSERT INTO projects
          (project_id,display_name,description,environment,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'candidate',$5,$5)
         ON CONFLICT (project_id) DO UPDATE
         SET display_name=CASE WHEN projects.status='candidate' THEN EXCLUDED.display_name ELSE projects.display_name END,
             description=CASE WHEN projects.status='candidate' THEN EXCLUDED.description ELSE projects.description END,
             updated_at=EXCLUDED.updated_at`,
        [
          candidate.projectId,
          candidate.displayName,
          candidate.description ?? null,
          candidate.environment ?? 'production',
          now,
        ],
      );
      const aliases = new Set([
        candidate.displayName,
        candidate.projectId,
        ...(candidate.aliases ?? []),
      ]);
      for (const alias of aliases) {
        await this.client.query(
          `INSERT INTO project_aliases (project_id,alias,created_at)
           VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [candidate.projectId, alias.trim(), now],
        );
      }
      await this.client.query(
        `INSERT INTO project_members (project_id,actor_id,role,status,created_at,updated_at)
         VALUES ($1,$2,'owner','active',$3,$3)
         ON CONFLICT (project_id,actor_id) DO UPDATE
         SET role='owner',status='active',updated_at=EXCLUDED.updated_at`,
        [candidate.projectId, ownerActorId, now],
      );
      for (const resource of candidate.resources ?? []) {
        await this.client.query(
          `INSERT INTO project_resources
            (resource_id,project_id,provider,resource_type,external_id,display_name,canonical_url,status,metadata,discovered_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8::jsonb,$9,$9)
           ON CONFLICT (project_id,provider,resource_type,external_id) DO UPDATE
           SET display_name=EXCLUDED.display_name,canonical_url=EXCLUDED.canonical_url,
               status='active',metadata=EXCLUDED.metadata,updated_at=EXCLUDED.updated_at`,
          [
            resource.resourceId,
            candidate.projectId,
            resource.provider,
            resource.resourceType,
            resource.externalId,
            resource.displayName,
            resource.canonicalUrl ?? null,
            JSON.stringify(resource.metadata ?? {}),
            now,
          ],
        );
      }
      const project = await this.findById(candidate.projectId);
      if (project === undefined) throw new Error('PROJECT_IMPORT_READBACK_FAILED');
      imported.push(project);
    }
    return imported;
  }

  async setStatus(projectId: string, status: ProjectStatus): Promise<ProjectRecord | undefined> {
    const result = await this.client.query(
      'UPDATE projects SET status=$2,updated_at=now() WHERE project_id=$1',
      [projectId, status],
    );
    return (result.rowCount ?? 0) === 0 ? undefined : this.findById(projectId);
  }

  async findResource(
    projectId: string,
    provider: ProjectResourceProvider,
    resourceType: ProjectResourceType,
  ): Promise<ProjectResourceRecord | undefined> {
    const result = await this.client.query<ProjectResourceRow>(
      `SELECT resource_id,project_id,provider,resource_type,external_id,display_name,
              canonical_url,status,metadata,discovered_at,updated_at
       FROM project_resources
       WHERE project_id=$1 AND provider=$2 AND resource_type=$3 AND status='active'
       ORDER BY updated_at DESC LIMIT 1`,
      [projectId, provider, resourceType],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapResource(row);
  }
}

interface EventRow extends Record<string, unknown> {
  event_id: string;
  event_type: string;
  event_version: number;
  occurred_at: Date;
  recorded_at: Date;
  correlation_id: string;
  causation_id: string | null;
  command_id: string | null;
  workflow_id: string | null;
  actor_id: string | null;
  project_id: string | null;
  payload: Record<string, unknown>;
}

const mapEvent = (row: EventRow): EventEnvelope => ({
  eventId: row.event_id,
  eventType: row.event_type,
  eventVersion: row.event_version,
  occurredAt: row.occurred_at.toISOString(),
  recordedAt: row.recorded_at.toISOString(),
  correlationId: row.correlation_id,
  ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
  ...(row.command_id === null ? {} : { commandId: row.command_id }),
  ...(row.workflow_id === null ? {} : { workflowId: row.workflow_id }),
  ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
  ...(row.project_id === null ? {} : { projectId: row.project_id }),
  payload: row.payload,
});

export class PostgresEventStore implements EventStore {
  constructor(private readonly client: SqlClient) {}

  async append(event: EventEnvelope): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO kernel_events
          (event_id,event_type,event_version,occurred_at,recorded_at,correlation_id,causation_id,command_id,workflow_id,actor_id,project_id,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          event.eventId,
          event.eventType,
          event.eventVersion,
          event.occurredAt,
          event.recordedAt,
          event.correlationId,
          event.causationId ?? null,
          event.commandId ?? null,
          event.workflowId ?? null,
          event.actorId ?? null,
          event.projectId ?? null,
          JSON.stringify(event.payload),
        ],
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new Error('EVENT_ID_CONFLICT');
      }
      throw error;
    }
  }

  findByCorrelation(value: string): Promise<readonly EventEnvelope[]> {
    return this.find('correlation_id', value);
  }
  findByCommand(value: string): Promise<readonly EventEnvelope[]> {
    return this.find('command_id', value);
  }
  findByWorkflow(value: string): Promise<readonly EventEnvelope[]> {
    return this.find('workflow_id', value);
  }

  private async find(
    column: 'correlation_id' | 'command_id' | 'workflow_id',
    value: string,
  ): Promise<readonly EventEnvelope[]> {
    const result = await this.client.query<EventRow>(
      `SELECT * FROM kernel_events WHERE ${column} = $1 ORDER BY sequence_id`,
      [value],
    );
    return result.rows.map(mapEvent);
  }
}

interface ReservationRow extends Record<string, unknown> {
  command_id: string;
  payload_hash: string;
}

export class PostgresIdempotencyRegistry implements IdempotencyRegistry {
  constructor(private readonly client: SqlClient) {}

  async reserve(request: ReservationRequest): Promise<ReservationResult> {
    const inserted = await this.client.query<ReservationRow>(
      `INSERT INTO kernel_idempotency
        (actor_id,project_id,command_type,idempotency_key,command_id,payload_hash,reserved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (actor_id,project_id,command_type,idempotency_key) DO NOTHING
       RETURNING command_id,payload_hash`,
      [
        request.actorId,
        request.projectId,
        request.commandType,
        request.idempotencyKey,
        request.commandId,
        request.requestFingerprint,
        request.createdAt,
      ],
    );
    if ((inserted.rowCount ?? 0) === 1) return { disposition: 'reserved' };
    const existing = await this.client.query<ReservationRow>(
      `SELECT command_id,payload_hash FROM kernel_idempotency
       WHERE actor_id=$1 AND project_id=$2 AND command_type=$3 AND idempotency_key=$4`,
      [request.actorId, request.projectId, request.commandType, request.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error('IDEMPOTENCY_RESERVATION_RACE');
    return row.payload_hash === request.requestFingerprint
      ? { disposition: 'duplicate', commandId: row.command_id }
      : { disposition: 'conflict', commandId: row.command_id };
  }
}

interface WorkflowRow extends Record<string, unknown> {
  state: WorkflowInstance;
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(private readonly client: SqlClient) {}

  async create(workflow: WorkflowInstance): Promise<void> {
    await this.client.query(
      `INSERT INTO kernel_workflows
       (workflow_id,command_id,correlation_id,definition_id,definition_version,status,state,created_at,updated_at)
       VALUES ($1,$2,$2,$3,1,$4,$5::jsonb,$6,$7)`,
      [
        workflow.workflowId,
        workflow.commandId,
        workflow.workflowType,
        workflow.state,
        JSON.stringify(workflow),
        workflow.createdAt,
        workflow.updatedAt,
      ],
    );
  }

  async get(workflowId: string): Promise<WorkflowInstance | undefined> {
    const result = await this.client.query<WorkflowRow>(
      'SELECT state FROM kernel_workflows WHERE workflow_id=$1',
      [workflowId],
    );
    return result.rows[0]?.state;
  }

  async save(workflow: WorkflowInstance, expectedVersion: number): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE kernel_workflows SET status=$2,state=$3::jsonb,updated_at=$4
       WHERE workflow_id=$1 AND (state->>'version')::integer=$5`,
      [
        workflow.workflowId,
        workflow.state,
        JSON.stringify(workflow),
        workflow.updatedAt,
        expectedVersion,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }
}

interface ConversationSessionRow extends Record<string, unknown> {
  session_id: string;
  contract_version: '1.0.0';
  principal_id: string;
  project_id: string;
  channel: ConversationSession['channel'];
  driving_mode: boolean;
  status: ConversationStatus;
  started_at: Date;
  last_activity_at: Date;
  closed_at: Date | null;
}

interface ConversationTurnRow extends Record<string, unknown> {
  turn_id: string;
  session_id: string;
  turn_sequence: string | number;
  role: ConversationTurn['role'];
  kind: ConversationTurn['kind'];
  text: string;
  idempotency_key: string;
  command_id: string | null;
  correlation_id: string | null;
  created_at: Date;
}

const mapSession = (row: ConversationSessionRow): ConversationSession => ({
  sessionId: row.session_id,
  contractVersion: row.contract_version,
  principalId: row.principal_id,
  projectId: row.project_id,
  channel: row.channel,
  drivingMode: row.driving_mode,
  status: row.status,
  startedAt: row.started_at.toISOString(),
  lastActivityAt: row.last_activity_at.toISOString(),
  ...(row.closed_at === null ? {} : { closedAt: row.closed_at.toISOString() }),
});

const mapTurn = (row: ConversationTurnRow): ConversationTurn => ({
  turnId: row.turn_id,
  sessionId: row.session_id,
  sequence: Number(row.turn_sequence),
  role: row.role,
  kind: row.kind,
  text: row.text,
  idempotencyKey: row.idempotency_key,
  ...(row.command_id === null ? {} : { commandId: row.command_id }),
  ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
  createdAt: row.created_at.toISOString(),
});

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly client: SqlClient) {}

  async createSession(session: ConversationSession): Promise<void> {
    await this.client.query(
      `INSERT INTO conversation_sessions
       (session_id,contract_version,principal_id,project_id,channel,driving_mode,status,started_at,last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        session.sessionId,
        session.contractVersion,
        session.principalId,
        session.projectId,
        session.channel,
        session.drivingMode,
        session.status,
        session.startedAt,
        session.lastActivityAt,
      ],
    );
  }

  async getSession(sessionId: string): Promise<ConversationSession | undefined> {
    const result = await this.client.query<ConversationSessionRow>(
      'SELECT * FROM conversation_sessions WHERE session_id=$1',
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapSession(row);
  }

  async updateSessionStatus(
    sessionId: string,
    status: ConversationStatus,
    at: string,
  ): Promise<ConversationSession | undefined> {
    const result = await this.client.query<ConversationSessionRow>(
      `UPDATE conversation_sessions
       SET status=$2::text,
           last_activity_at=$3::timestamptz,
           closed_at=CASE
             WHEN $2::text='closed' THEN $3::timestamptz
             ELSE NULL::timestamptz
           END
       WHERE session_id=$1 RETURNING *`,
      [sessionId, status, at],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapSession(row);
  }

  async updateSessionProject(
    sessionId: string,
    projectId: string,
    at: string,
  ): Promise<ConversationSession | undefined> {
    const result = await this.client.query<ConversationSessionRow>(
      `UPDATE conversation_sessions
       SET project_id=$2,last_activity_at=$3
       WHERE session_id=$1 RETURNING *`,
      [sessionId, projectId, at],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapSession(row);
  }

  async appendTurn(input: Omit<ConversationTurn, 'sequence'>): Promise<ConversationTurn> {
    const result = await this.client.query<ConversationTurnRow>(
      `WITH inserted AS (
         INSERT INTO conversation_turns
          (turn_id,session_id,role,kind,text,idempotency_key,command_id,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *
       ), touched AS (
         UPDATE conversation_sessions SET last_activity_at=$9,status='active'
         WHERE session_id=$2 RETURNING session_id
       ) SELECT inserted.* FROM inserted,touched`,
      [
        input.turnId,
        input.sessionId,
        input.role,
        input.kind,
        input.text,
        input.idempotencyKey,
        input.commandId ?? null,
        input.correlationId ?? null,
        input.createdAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('CONVERSATION_APPEND_FAILED');
    return mapTurn(row);
  }

  async findTurnByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ConversationTurn | undefined> {
    const result = await this.client.query<ConversationTurnRow>(
      'SELECT * FROM conversation_turns WHERE session_id=$1 AND idempotency_key=$2',
      [sessionId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapTurn(row);
  }

  async listTurns(sessionId: string, limit: number): Promise<readonly ConversationTurn[]> {
    const result = await this.client.query<ConversationTurnRow>(
      `SELECT * FROM (
         SELECT * FROM conversation_turns WHERE session_id=$1 ORDER BY turn_sequence DESC LIMIT $2
       ) recent ORDER BY turn_sequence ASC`,
      [sessionId, limit],
    );
    return result.rows.map(mapTurn);
  }

  async listProjectSummaries(
    principalId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ConversationTurn[]> {
    const result = await this.client.query<ConversationTurnRow>(
      `SELECT t.* FROM conversation_turns t
       JOIN conversation_sessions s ON s.session_id=t.session_id
       WHERE s.principal_id=$1 AND s.project_id=$2 AND t.kind='summary'
       ORDER BY t.created_at DESC LIMIT $3`,
      [principalId, projectId, limit],
    );
    return [...result.rows].reverse().map(mapTurn);
  }
}
