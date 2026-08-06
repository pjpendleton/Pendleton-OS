import type { WorkflowInstance } from './workflow-orchestrator.js';

export interface WorkflowRepository {
  create(workflow: WorkflowInstance): Promise<void>;
  get(workflowId: string): Promise<WorkflowInstance | undefined>;
  save(workflow: WorkflowInstance, expectedVersion: number): Promise<boolean>;
}

const clone = (workflow: WorkflowInstance): WorkflowInstance => structuredClone(workflow);

export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly #workflows = new Map<string, WorkflowInstance>();

  create(workflow: WorkflowInstance): Promise<void> {
    if (this.#workflows.has(workflow.workflowId)) {
      return Promise.reject(new Error('Workflow already exists.'));
    }
    this.#workflows.set(workflow.workflowId, clone(workflow));
    return Promise.resolve();
  }

  get(workflowId: string): Promise<WorkflowInstance | undefined> {
    const workflow = this.#workflows.get(workflowId);
    return Promise.resolve(workflow === undefined ? undefined : clone(workflow));
  }

  save(workflow: WorkflowInstance, expectedVersion: number): Promise<boolean> {
    const current = this.#workflows.get(workflow.workflowId);
    if (current === undefined || current.version !== expectedVersion) return Promise.resolve(false);
    this.#workflows.set(workflow.workflowId, clone(workflow));
    return Promise.resolve(true);
  }
}
