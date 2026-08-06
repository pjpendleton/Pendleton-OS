import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryWorkflowRepository,
  WorkflowOrchestrator,
  type WorkflowDefinition,
} from '../src/index.js';

const ids = ['step-1', 'step-2', 'step-3'];
const createDefinition = (
  execute = vi.fn().mockResolvedValue({ ok: true }),
): WorkflowDefinition => ({
  workflowType: 'artifact.create',
  steps: [
    { stepType: 'policy', maxAttempts: 1, timeoutMs: 100, execute },
    { stepType: 'provider', maxAttempts: 2, timeoutMs: 100, execute },
  ],
});
const startRequest = (definition: WorkflowDefinition) => ({
  workflowId: 'workflow-1',
  commandId: 'command-1',
  definition,
  context: { title: 'Brief' },
  createdAt: '2026-08-06T17:00:00.000Z',
  createStepId: (() => {
    let index = 0;
    return () => ids[index++] ?? `step-${String(index)}`;
  })(),
});

describe('WorkflowOrchestrator', () => {
  it('executes ordered steps and completes durably', async () => {
    const repository = new InMemoryWorkflowRepository();
    const definition = createDefinition();
    const orchestrator = new WorkflowOrchestrator({ repository, definitions: [definition] });
    await orchestrator.start(startRequest(definition));
    const result = await orchestrator.run('workflow-1');
    expect(result).toMatchObject({
      disposition: 'completed',
      workflow: { state: 'completed', currentStepIndex: 2 },
    });
    expect((await repository.get('workflow-1'))?.state).toBe('completed');
  });

  it('pauses and resumes a confirmation step', async () => {
    const repository = new InMemoryWorkflowRepository();
    const definition: WorkflowDefinition = {
      workflowType: 'confirming',
      steps: [
        {
          stepType: 'send',
          confirmationRequired: true,
          maxAttempts: 1,
          timeoutMs: 100,
          execute: vi.fn().mockResolvedValue({ sent: true }),
        },
      ],
    };
    const orchestrator = new WorkflowOrchestrator({ repository, definitions: [definition] });
    await orchestrator.start({ ...startRequest(definition), workflowId: 'workflow-confirm' });
    expect(await orchestrator.run('workflow-confirm')).toMatchObject({
      disposition: 'waiting_confirmation',
    });
    expect(await orchestrator.confirm('workflow-confirm')).toMatchObject({
      disposition: 'completed',
    });
  });

  it('retries a retryable step within its attempt limit', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ ok: true });
    const repository = new InMemoryWorkflowRepository();
    const definition: WorkflowDefinition = {
      workflowType: 'retry',
      steps: [{ stepType: 'provider', maxAttempts: 2, timeoutMs: 100, execute }],
    };
    const orchestrator = new WorkflowOrchestrator({ repository, definitions: [definition] });
    await orchestrator.start({ ...startRequest(definition), workflowId: 'workflow-retry' });
    expect(await orchestrator.run('workflow-retry')).toMatchObject({ disposition: 'completed' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails deterministically when attempts are exhausted', async () => {
    const repository = new InMemoryWorkflowRepository();
    const definition: WorkflowDefinition = {
      workflowType: 'failure',
      steps: [
        {
          stepType: 'provider',
          maxAttempts: 1,
          timeoutMs: 100,
          execute: vi.fn().mockRejectedValue(new Error('down')),
        },
      ],
    };
    const orchestrator = new WorkflowOrchestrator({ repository, definitions: [definition] });
    await orchestrator.start({ ...startRequest(definition), workflowId: 'workflow-fail' });
    expect(await orchestrator.run('workflow-fail')).toMatchObject({
      disposition: 'failed',
      workflow: { state: 'failed', steps: [{ errorCode: 'STEP_EXECUTION_FAILED' }] },
    });
  });

  it('times out a stalled step', async () => {
    const repository = new InMemoryWorkflowRepository();
    const definition: WorkflowDefinition = {
      workflowType: 'timeout',
      steps: [
        {
          stepType: 'provider',
          maxAttempts: 1,
          timeoutMs: 5,
          execute: () => new Promise(() => undefined),
        },
      ],
    };
    const orchestrator = new WorkflowOrchestrator({ repository, definitions: [definition] });
    await orchestrator.start({ ...startRequest(definition), workflowId: 'workflow-timeout' });
    expect(await orchestrator.run('workflow-timeout')).toMatchObject({
      disposition: 'failed',
      workflow: { steps: [{ errorCode: 'STEP_TIMEOUT' }] },
    });
  });

  it('continues from persisted state after orchestrator replacement', async () => {
    const repository = new InMemoryWorkflowRepository();
    const definition = createDefinition();
    const first = new WorkflowOrchestrator({ repository, definitions: [definition] });
    await first.start({ ...startRequest(definition), workflowId: 'workflow-restart' });
    const replacement = new WorkflowOrchestrator({ repository, definitions: [definition] });
    expect(await replacement.run('workflow-restart')).toMatchObject({ disposition: 'completed' });
  });
});
