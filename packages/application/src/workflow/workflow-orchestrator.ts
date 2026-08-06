import type { WorkflowRepository } from './workflow-repository.js';

export type WorkflowState =
  | 'accepted'
  | 'running'
  | 'waiting_confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type WorkflowStepState =
  | 'pending'
  | 'running'
  | 'waiting_confirmation'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface WorkflowStepDefinition {
  readonly stepType: string;
  readonly confirmationRequired?: boolean;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  execute(context: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

export interface WorkflowDefinition {
  readonly workflowType: string;
  readonly steps: readonly WorkflowStepDefinition[];
}

export interface WorkflowStepInstance {
  readonly stepId: string;
  readonly stepType: string;
  readonly state: WorkflowStepState;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly confirmationRequired: boolean;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly errorCode?: string;
}

export interface WorkflowInstance {
  readonly workflowId: string;
  readonly commandId: string;
  readonly workflowType: string;
  readonly state: WorkflowState;
  readonly version: number;
  readonly currentStepIndex: number;
  readonly steps: readonly WorkflowStepInstance[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StartWorkflowRequest {
  readonly workflowId: string;
  readonly commandId: string;
  readonly definition: WorkflowDefinition;
  readonly context: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly createStepId: () => string;
}

export type WorkflowExecutionResult =
  | { readonly disposition: 'completed'; readonly workflow: WorkflowInstance }
  | { readonly disposition: 'waiting_confirmation'; readonly workflow: WorkflowInstance }
  | { readonly disposition: 'failed'; readonly workflow: WorkflowInstance }
  | { readonly disposition: 'conflict' }
  | { readonly disposition: 'not_found' };

export class WorkflowOrchestrator {
  readonly #repository: WorkflowRepository;
  readonly #definitions: ReadonlyMap<string, WorkflowDefinition>;
  readonly #now: () => Date;

  constructor(options: {
    repository: WorkflowRepository;
    definitions: readonly WorkflowDefinition[];
    now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#definitions = new Map(options.definitions.map((item) => [item.workflowType, item]));
    this.#now = options.now ?? (() => new Date());
  }

  async start(request: StartWorkflowRequest): Promise<WorkflowInstance> {
    if (request.definition.steps.length === 0)
      throw new Error('Workflow requires at least one step.');
    const workflow: WorkflowInstance = {
      workflowId: request.workflowId,
      commandId: request.commandId,
      workflowType: request.definition.workflowType,
      state: 'accepted',
      version: 1,
      currentStepIndex: 0,
      steps: request.definition.steps.map((step) => ({
        stepId: request.createStepId(),
        stepType: step.stepType,
        state: 'pending',
        attemptCount: 0,
        maxAttempts: step.maxAttempts,
        timeoutMs: step.timeoutMs,
        confirmationRequired: step.confirmationRequired ?? false,
      })),
      context: request.context,
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    };
    await this.#repository.create(workflow);
    return workflow;
  }

  async run(workflowId: string): Promise<WorkflowExecutionResult> {
    const workflow = await this.#repository.get(workflowId);
    if (workflow === undefined) return { disposition: 'not_found' };
    if (workflow.state === 'completed') return { disposition: 'completed', workflow };
    if (workflow.state === 'failed') return { disposition: 'failed', workflow };
    const definition = this.#definitions.get(workflow.workflowType);
    if (definition === undefined) return this.#fail(workflow, 'WORKFLOW_DEFINITION_NOT_FOUND');

    let current = workflow;
    while (current.currentStepIndex < current.steps.length) {
      const step = current.steps[current.currentStepIndex];
      const stepDefinition = definition.steps[current.currentStepIndex];
      if (step === undefined || stepDefinition === undefined) {
        return this.#fail(current, 'WORKFLOW_STEP_DEFINITION_MISMATCH');
      }
      if (step.confirmationRequired && step.state === 'pending') {
        return this.#transitionStep(current, step, 'waiting_confirmation', 'waiting_confirmation');
      }
      if (step.state === 'waiting_confirmation') {
        return { disposition: 'waiting_confirmation', workflow: current };
      }
      const attempt = step.attemptCount + 1;
      const running = this.#replaceStep(
        current,
        step.stepId,
        { ...step, state: 'running', attemptCount: attempt },
        'running',
      );
      const saved = await this.#repository.save(running, current.version);
      if (!saved) return { disposition: 'conflict' };
      current = running;
      try {
        const output = await this.#withTimeout(
          stepDefinition.execute(current.context),
          step.timeoutMs,
        );
        const succeeded = this.#replaceStep(
          current,
          step.stepId,
          { ...step, state: 'succeeded', attemptCount: attempt, output },
          'running',
          current.currentStepIndex + 1,
        );
        const advanced =
          succeeded.currentStepIndex >= succeeded.steps.length
            ? { ...succeeded, state: 'completed' as const }
            : succeeded;
        if (!(await this.#repository.save(advanced, current.version)))
          return { disposition: 'conflict' };
        current = advanced;
      } catch (cause: unknown) {
        const code =
          cause instanceof Error && cause.message === 'STEP_TIMEOUT'
            ? 'STEP_TIMEOUT'
            : 'STEP_EXECUTION_FAILED';
        const latestStep = current.steps[current.currentStepIndex];
        if (latestStep === undefined) return this.#fail(current, code);
        if (attempt < latestStep.maxAttempts) {
          const retry = this.#replaceStep(
            current,
            latestStep.stepId,
            { ...latestStep, state: 'pending', errorCode: code },
            'running',
          );
          if (!(await this.#repository.save(retry, current.version)))
            return { disposition: 'conflict' };
          current = retry;
          continue;
        }
        return this.#fail(current, code);
      }
    }
    return { disposition: 'completed', workflow: current };
  }

  async confirm(workflowId: string): Promise<WorkflowExecutionResult> {
    const workflow = await this.#repository.get(workflowId);
    if (workflow === undefined) return { disposition: 'not_found' };
    const step = workflow.steps[workflow.currentStepIndex];
    if (workflow.state !== 'waiting_confirmation' || step?.state !== 'waiting_confirmation') {
      return { disposition: 'conflict' };
    }
    const resumed = this.#replaceStep(
      workflow,
      step.stepId,
      { ...step, state: 'pending', confirmationRequired: false },
      'running',
    );
    if (!(await this.#repository.save(resumed, workflow.version)))
      return { disposition: 'conflict' };
    return this.run(workflowId);
  }

  async #fail(workflow: WorkflowInstance, errorCode: string): Promise<WorkflowExecutionResult> {
    const step = workflow.steps[workflow.currentStepIndex];
    const failed =
      step === undefined
        ? {
            ...workflow,
            state: 'failed' as const,
            version: workflow.version + 1,
            updatedAt: this.#now().toISOString(),
          }
        : this.#replaceStep(
            workflow,
            step.stepId,
            { ...step, state: 'failed', errorCode },
            'failed',
          );
    if (!(await this.#repository.save(failed, workflow.version)))
      return { disposition: 'conflict' };
    return { disposition: 'failed', workflow: failed };
  }

  async #transitionStep(
    workflow: WorkflowInstance,
    step: WorkflowStepInstance,
    stepState: WorkflowStepState,
    workflowState: WorkflowState,
  ): Promise<WorkflowExecutionResult> {
    const next = this.#replaceStep(
      workflow,
      step.stepId,
      { ...step, state: stepState },
      workflowState,
    );
    if (!(await this.#repository.save(next, workflow.version))) return { disposition: 'conflict' };
    return { disposition: 'waiting_confirmation', workflow: next };
  }

  #replaceStep(
    workflow: WorkflowInstance,
    stepId: string,
    replacement: WorkflowStepInstance,
    state: WorkflowState,
    currentStepIndex = workflow.currentStepIndex,
  ): WorkflowInstance {
    return {
      ...workflow,
      state,
      version: workflow.version + 1,
      currentStepIndex,
      steps: workflow.steps.map((step) => (step.stepId === stepId ? replacement : step)),
      updatedAt: this.#now().toISOString(),
    };
  }

  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('STEP_TIMEOUT'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
