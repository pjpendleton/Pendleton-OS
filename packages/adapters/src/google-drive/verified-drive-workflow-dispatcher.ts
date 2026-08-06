import type { Command } from '@pendleton-os/contracts';
import type {
  EventRecorder,
  PolicyDecision,
  WorkflowDispatcher,
  ArtifactVerifier,
} from '@pendleton-os/application';
import type { GoogleDriveAdapter } from './google-drive-adapter.js';

const stringPayload = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

export class VerifiedDriveWorkflowDispatcher implements WorkflowDispatcher {
  readonly #drive: GoogleDriveAdapter;
  readonly #verifier: ArtifactVerifier;
  readonly #events: EventRecorder;
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(options: {
    drive: GoogleDriveAdapter;
    verifier: ArtifactVerifier;
    events: EventRecorder;
    createId: () => string;
    now?: () => Date;
  }) {
    this.#drive = options.drive;
    this.#verifier = options.verifier;
    this.#events = options.events;
    this.#createId = options.createId;
    this.#now = options.now ?? (() => new Date());
  }

  async dispatch(
    command: Command,
    policyDecision: PolicyDecision,
  ): Promise<{ workflowId: string }> {
    if (policyDecision.disposition !== 'allow') throw new Error('WORKFLOW_POLICY_NOT_ALLOWED');
    if (command.commandType !== 'artifact.create') throw new Error('WORKFLOW_COMMAND_UNSUPPORTED');
    const workflowId = this.#createId();
    await this.#record('workflow.started', command, workflowId, {
      policyDecisionId: policyDecision.policyDecisionId,
    });
    try {
      const name = stringPayload(command.payload.title, 'Untitled Artifact');
      const text = stringPayload(command.payload.text, stringPayload(command.payload.content, ''));
      const result = await this.#drive.create(command.projectContext.projectId, { name, text });
      await this.#record('provider.mutation_succeeded', command, workflowId, {
        evidence: result.evidence,
      });
      const verification = await this.#verifier.verify({
        fileId: result.document.fileId,
        projectRootId: result.document.parentIds[0] ?? '',
        expectedText: text,
      });
      await this.#record('verification.completed', command, workflowId, { verification });
      if (verification.disposition !== 'verified') throw new Error('WORKFLOW_VERIFICATION_FAILED');
      await this.#record('workflow.completed', command, workflowId, {
        artifactId: result.document.fileId,
      });
      return { workflowId };
    } catch (error) {
      await this.#record('workflow.failed', command, workflowId, {
        errorCode: error instanceof Error ? error.message : 'WORKFLOW_UNKNOWN_FAILURE',
      });
      throw error;
    }
  }

  async #record(
    eventType: string,
    command: Command,
    workflowId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const occurredAt = this.#now().toISOString();
    await this.#events.record({
      eventId: this.#createId(),
      eventType,
      eventVersion: 1,
      occurredAt,
      correlationId: command.correlationId,
      commandId: command.commandId,
      workflowId,
      actorId: command.actor.actorId,
      projectId: command.projectContext.projectId,
      payload,
    });
  }
}
