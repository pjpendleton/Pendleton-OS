export const CONTRACT_VERSION = '1.0.0' as const;

export const contractNames = [
  'Actor',
  'ProjectContext',
  'Command',
  'PolicyDecision',
  'WorkflowStep',
  'Workflow',
  'Artifact',
  'VerificationResult',
  'Event',
  'PendletonError',
  'IdempotencyRecord',
] as const;

export type ContractName = (typeof contractNames)[number];

export type ActorType = 'human' | 'service' | 'system';
export type InterfaceChannel = 'api' | 'web' | 'mobile' | 'voice' | 'automation';
export type Environment = 'development' | 'test' | 'staging' | 'production';

export interface Actor {
  readonly actorId: string;
  readonly actorType: ActorType;
  readonly roles: readonly string[];
}

export interface ProjectContext {
  readonly projectId: string;
  readonly environment: Environment;
  readonly targetResourceId?: string;
}

export interface InterfaceContext {
  readonly channel: InterfaceChannel;
  readonly drivingMode?: boolean;
}

export interface Command {
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly commandType: string;
  readonly actor: Actor;
  readonly projectContext: ProjectContext;
  readonly interfaceContext: InterfaceContext;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestedAt: string;
}

export type ErrorCategory =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'policy'
  | 'conflict'
  | 'provider'
  | 'verification'
  | 'internal';

export interface PendletonError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}
