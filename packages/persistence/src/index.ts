import pg from 'pg';
import type {
  EventEnvelope,
  EventStore,
  IdempotencyRegistry,
  ReservationRequest,
  ReservationResult,
  WorkflowInstance,
  WorkflowRepository,
} from '@pendleton-os/application';

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
