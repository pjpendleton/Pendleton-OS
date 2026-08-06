export interface EventEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly commandId?: string;
  readonly workflowId?: string;
  readonly actorId?: string;
  readonly projectId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type AppendEventRequest = Omit<EventEnvelope, 'recordedAt' | 'payload'> & {
  readonly payload: Readonly<Record<string, unknown>>;
};

export interface EventStore {
  append(event: EventEnvelope): Promise<void>;
  findByCorrelation(correlationId: string): Promise<readonly EventEnvelope[]>;
  findByCommand(commandId: string): Promise<readonly EventEnvelope[]>;
  findByWorkflow(workflowId: string): Promise<readonly EventEnvelope[]>;
}

const sensitiveKey = /password|secret|token|credential|authorization|cookie/i;

const sanitize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKey.test(key) ? '[REDACTED]' : sanitize(entry),
    ]),
  );
};

export class EventRecorder {
  readonly #store: EventStore;
  readonly #now: () => Date;

  constructor(options: { store: EventStore; now?: () => Date }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  async record(request: AppendEventRequest): Promise<EventEnvelope> {
    if (request.eventVersion < 1) throw new Error('EVENT_VERSION_INVALID');
    if (request.correlationId.trim().length === 0) throw new Error('EVENT_CORRELATION_REQUIRED');
    const event: EventEnvelope = Object.freeze({
      ...request,
      recordedAt: this.#now().toISOString(),
      payload: Object.freeze(sanitize(request.payload) as Readonly<Record<string, unknown>>),
    });
    await this.#store.append(event);
    return event;
  }
}

export class InMemoryEventStore implements EventStore {
  readonly #events: EventEnvelope[] = [];
  readonly #ids = new Set<string>();

  append(event: EventEnvelope): Promise<void> {
    if (this.#ids.has(event.eventId)) return Promise.reject(new Error('EVENT_ID_CONFLICT'));
    this.#ids.add(event.eventId);
    this.#events.push(structuredClone(event));
    return Promise.resolve();
  }

  findByCorrelation(correlationId: string): Promise<readonly EventEnvelope[]> {
    return Promise.resolve(this.#find((event) => event.correlationId === correlationId));
  }

  findByCommand(commandId: string): Promise<readonly EventEnvelope[]> {
    return Promise.resolve(this.#find((event) => event.commandId === commandId));
  }

  findByWorkflow(workflowId: string): Promise<readonly EventEnvelope[]> {
    return Promise.resolve(this.#find((event) => event.workflowId === workflowId));
  }

  #find(predicate: (event: EventEnvelope) => boolean): readonly EventEnvelope[] {
    return this.#events.filter(predicate).map((event) => structuredClone(event));
  }
}
