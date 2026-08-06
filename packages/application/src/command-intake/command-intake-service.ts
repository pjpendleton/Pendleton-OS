import { createHash, randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  type Actor,
  type Command,
  type InterfaceContext,
  type PendletonError,
  type ProjectContext,
} from '@pendleton-os/contracts';
import type { IdempotencyRegistry } from './idempotency-registry.js';
import type { CommandCatalog, ValidationIssue } from './standard-command-catalog.js';

export interface CommandSubmission {
  readonly commandType?: unknown;
  readonly idempotencyKey?: unknown;
  readonly correlationId?: unknown;
  readonly actor?: unknown;
  readonly projectContext?: unknown;
  readonly interfaceContext?: unknown;
  readonly payload?: unknown;
}

export type IntakeOutcome =
  | { readonly disposition: 'accepted'; readonly command: Command }
  | {
      readonly disposition: 'duplicate';
      readonly existingCommandId: string;
      readonly correlationId: string;
    }
  | {
      readonly disposition: 'rejected';
      readonly correlationId: string;
      readonly errors: readonly PendletonError[];
    };

export interface CommandIntakeDependencies {
  readonly catalog: CommandCatalog;
  readonly idempotencyRegistry: IdempotencyRegistry;
  readonly createId?: () => string;
  readonly now?: () => Date;
}

const environments = new Set(['development', 'test', 'staging', 'production']);
const channels = new Set(['api', 'web', 'mobile', 'voice', 'automation']);
const actorTypes = new Set(['human', 'service', 'system']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const commandTypePattern = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

const fingerprint = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');

const validationError = (
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PendletonError => ({
  code,
  category: 'validation',
  message,
  retryable: false,
  ...(details === undefined ? {} : { details }),
});

const issueError = (issue: ValidationIssue): PendletonError =>
  validationError(issue.code, issue.message, {
    classification: issue.classification,
    ...(issue.field === undefined ? {} : { field: issue.field }),
  });

function parseActor(value: unknown): Actor | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.actorId) || !uuidPattern.test(value.actorId)) {
    return undefined;
  }
  if (typeof value.actorType !== 'string' || !actorTypes.has(value.actorType)) return undefined;
  if (
    !Array.isArray(value.roles) ||
    value.roles.length === 0 ||
    !value.roles.every(isNonEmptyString)
  ) {
    return undefined;
  }
  return {
    actorId: value.actorId,
    actorType: value.actorType as Actor['actorType'],
    roles: [...new Set(value.roles.map((role) => role.trim()))],
  };
}

function parseProjectContext(value: unknown): ProjectContext | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.projectId)) return undefined;
  if (typeof value.environment !== 'string' || !environments.has(value.environment)) {
    return undefined;
  }
  if (value.targetResourceId !== undefined && !isNonEmptyString(value.targetResourceId)) {
    return undefined;
  }
  return {
    projectId: value.projectId.trim(),
    environment: value.environment as ProjectContext['environment'],
    ...(value.targetResourceId === undefined
      ? {}
      : { targetResourceId: value.targetResourceId.trim() }),
  };
}

function parseInterfaceContext(value: unknown): InterfaceContext | undefined {
  if (!isRecord(value) || typeof value.channel !== 'string' || !channels.has(value.channel)) {
    return undefined;
  }
  if (value.drivingMode !== undefined && typeof value.drivingMode !== 'boolean') return undefined;
  return {
    channel: value.channel as InterfaceContext['channel'],
    ...(value.drivingMode === undefined ? {} : { drivingMode: value.drivingMode }),
  };
}

export class CommandIntakeService {
  readonly #catalog: CommandCatalog;
  readonly #idempotencyRegistry: IdempotencyRegistry;
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(dependencies: CommandIntakeDependencies) {
    this.#catalog = dependencies.catalog;
    this.#idempotencyRegistry = dependencies.idempotencyRegistry;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async accept(submission: CommandSubmission): Promise<IntakeOutcome> {
    const correlationId =
      typeof submission.correlationId === 'string' && uuidPattern.test(submission.correlationId)
        ? submission.correlationId
        : this.#createId();
    const errors: PendletonError[] = [];
    const commandType = isNonEmptyString(submission.commandType)
      ? submission.commandType.trim()
      : undefined;
    const idempotencyKey = isNonEmptyString(submission.idempotencyKey)
      ? submission.idempotencyKey.trim()
      : undefined;
    const actor = parseActor(submission.actor);
    const projectContext = parseProjectContext(submission.projectContext);
    const interfaceContext = parseInterfaceContext(submission.interfaceContext);
    const payload = isRecord(submission.payload) ? submission.payload : undefined;

    if (commandType === undefined || !commandTypePattern.test(commandType)) {
      errors.push(
        validationError(
          'COMMAND_TYPE_INVALID',
          'Command type must use a versioned domain.action name.',
        ),
      );
    }
    if (idempotencyKey === undefined || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      errors.push(
        validationError(
          'IDEMPOTENCY_KEY_INVALID',
          'Idempotency key must contain 8 to 200 characters.',
        ),
      );
    }
    if (actor === undefined) {
      errors.push(
        validationError(
          'ACTOR_INVALID',
          'A resolved actor with a UUID, type, and role is required.',
        ),
      );
    }
    if (projectContext === undefined) {
      errors.push(
        validationError(
          'PROJECT_CONTEXT_INVALID',
          'A resolved project and environment are required.',
        ),
      );
    }
    if (interfaceContext === undefined) {
      errors.push(
        validationError('INTERFACE_CONTEXT_INVALID', 'A supported interface channel is required.'),
      );
    }
    if (payload === undefined) {
      errors.push(validationError('PAYLOAD_INVALID', 'Payload must be an object.'));
    }

    if (
      errors.length > 0 ||
      commandType === undefined ||
      idempotencyKey === undefined ||
      actor === undefined ||
      projectContext === undefined ||
      interfaceContext === undefined ||
      payload === undefined
    ) {
      return { disposition: 'rejected', correlationId, errors };
    }

    const definition = this.#catalog.get(commandType);
    if (definition === undefined) {
      return {
        disposition: 'rejected',
        correlationId,
        errors: [
          validationError(
            'COMMAND_TYPE_UNSUPPORTED',
            `Command type '${commandType}' is not supported.`,
          ),
        ],
      };
    }

    const semanticIssues = definition.validate(payload, projectContext.targetResourceId);
    if (semanticIssues.length > 0) {
      return {
        disposition: 'rejected',
        correlationId,
        errors: semanticIssues.map(issueError),
      };
    }

    const commandId = this.#createId();
    const requestedAt = this.#now().toISOString();
    const command: Command = Object.freeze({
      commandId,
      correlationId,
      idempotencyKey,
      contractVersion: CONTRACT_VERSION,
      commandType,
      actor,
      projectContext,
      interfaceContext,
      payload: Object.freeze({ ...payload }),
      requestedAt,
    });
    const requestFingerprint = fingerprint({
      commandType,
      actor,
      projectContext,
      interfaceContext,
      payload,
    });
    const reservation = await this.#idempotencyRegistry.reserve({
      actorId: actor.actorId,
      projectId: projectContext.projectId,
      commandType,
      idempotencyKey,
      requestFingerprint,
      commandId,
      createdAt: requestedAt,
    });
    if (reservation.disposition === 'duplicate') {
      return {
        disposition: 'duplicate',
        existingCommandId: reservation.commandId,
        correlationId,
      };
    }
    if (reservation.disposition === 'conflict') {
      return {
        disposition: 'rejected',
        correlationId,
        errors: [
          {
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            category: 'conflict',
            message: 'Idempotency key was already used for a different command.',
            retryable: false,
            details: { existingCommandId: reservation.commandId },
          },
        ],
      };
    }
    return { disposition: 'accepted', command };
  }
}
