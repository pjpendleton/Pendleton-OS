import type { Command, PendletonError } from '@pendleton-os/contracts';
import type {
  CommandIntakeService,
  CommandSubmission,
} from '../command-intake/command-intake-service.js';
import type {
  ContextResolutionService,
  ProjectSelector,
} from '../context-resolution/context-resolution-service.js';
import type { PolicyDecision, PolicyEngine, PolicyOperation } from '../policy/policy-engine.js';

export interface GatewayRequest {
  readonly principalId: string;
  readonly project: ProjectSelector;
  readonly targetResourceId?: string;
  readonly command: Omit<CommandSubmission, 'actor' | 'projectContext'>;
  readonly policy: {
    readonly operation: PolicyOperation;
    readonly dataClassification: 'public' | 'internal' | 'confidential' | 'restricted';
    readonly grantedScope: boolean;
    readonly verificationAvailable: boolean;
    readonly boundedChange?: boolean;
    readonly voiceConfirmationPermitted?: boolean;
    readonly secondApproverRequired?: boolean;
  };
}

export interface WorkflowDispatcher {
  dispatch(
    command: Command,
    policyDecision: PolicyDecision,
  ): Promise<{ readonly workflowId: string }>;
}

export type GatewayOutcome =
  | {
      readonly disposition: 'accepted';
      readonly commandId: string;
      readonly workflowId: string;
      readonly correlationId: string;
    }
  | {
      readonly disposition: 'duplicate';
      readonly commandId: string;
      readonly correlationId: string;
    }
  | {
      readonly disposition: 'confirmation_required';
      readonly policyDecision: PolicyDecision;
      readonly correlationId: string;
    }
  | {
      readonly disposition: 'escalated';
      readonly policyDecision: PolicyDecision;
      readonly correlationId: string;
    }
  | {
      readonly disposition: 'denied';
      readonly policyDecision: PolicyDecision;
      readonly correlationId: string;
    }
  | {
      readonly disposition: 'rejected';
      readonly errors: readonly PendletonError[];
      readonly correlationId?: string;
    };

export class UnifiedCommandGateway {
  readonly #contexts: ContextResolutionService;
  readonly #intake: CommandIntakeService;
  readonly #policy: PolicyEngine;
  readonly #workflows: WorkflowDispatcher;
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(options: {
    contexts: ContextResolutionService;
    intake: CommandIntakeService;
    policy: PolicyEngine;
    workflows: WorkflowDispatcher;
    createId: () => string;
    now: () => Date;
  }) {
    this.#contexts = options.contexts;
    this.#intake = options.intake;
    this.#policy = options.policy;
    this.#workflows = options.workflows;
    this.#createId = options.createId;
    this.#now = options.now;
  }

  async execute(request: GatewayRequest): Promise<GatewayOutcome> {
    const context = await this.#contexts.resolve({
      principalId: request.principalId,
      project: request.project,
      ...(request.targetResourceId === undefined
        ? {}
        : { targetResourceId: request.targetResourceId }),
    });
    if (context.disposition === 'rejected')
      return { disposition: 'rejected', errors: context.errors };
    const intake = await this.#intake.accept({
      ...request.command,
      actor: context.actor,
      projectContext: context.projectContext,
    });
    if (intake.disposition === 'rejected')
      return {
        disposition: 'rejected',
        errors: intake.errors,
        correlationId: intake.correlationId,
      };
    if (intake.disposition === 'duplicate')
      return {
        disposition: 'duplicate',
        commandId: intake.existingCommandId,
        correlationId: intake.correlationId,
      };
    const command = intake.command;
    const policyDecision = this.#policy.evaluate({
      policyDecisionId: this.#createId(),
      correlationId: command.correlationId,
      evaluatedAt: this.#now().toISOString(),
      actor: command.actor,
      interfaceContext: command.interfaceContext,
      projectContext: command.projectContext,
      operation: request.policy.operation,
      dataClassification: request.policy.dataClassification,
      exactTarget:
        request.policy.operation === 'artifact.create_internal' ||
        command.projectContext.targetResourceId !== undefined,
      grantedScope: request.policy.grantedScope,
      verificationAvailable: request.policy.verificationAvailable,
      ...(request.policy.boundedChange === undefined
        ? {}
        : { boundedChange: request.policy.boundedChange }),
      ...(request.policy.voiceConfirmationPermitted === undefined
        ? {}
        : { voiceConfirmationPermitted: request.policy.voiceConfirmationPermitted }),
      ...(request.policy.secondApproverRequired === undefined
        ? {}
        : { secondApproverRequired: request.policy.secondApproverRequired }),
    });
    if (policyDecision.disposition === 'deny')
      return { disposition: 'denied', policyDecision, correlationId: command.correlationId };
    if (policyDecision.disposition === 'confirm')
      return {
        disposition: 'confirmation_required',
        policyDecision,
        correlationId: command.correlationId,
      };
    if (policyDecision.disposition === 'escalate')
      return { disposition: 'escalated', policyDecision, correlationId: command.correlationId };
    const workflow = await this.#workflows.dispatch(command, policyDecision);
    return {
      disposition: 'accepted',
      commandId: command.commandId,
      workflowId: workflow.workflowId,
      correlationId: command.correlationId,
    };
  }
}
