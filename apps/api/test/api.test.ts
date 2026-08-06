import { describe, expect, it, vi } from 'vitest';
import { buildApi } from '../src/index.js';

describe('POST /v1/commands', () => {
  it('routes command requests only through the unified gateway', async () => {
    const execute = vi.fn().mockResolvedValue({
      disposition: 'accepted',
      commandId: 'command-1',
      workflowId: 'workflow-1',
      correlationId: 'correlation-1',
    });
    const app = buildApi({ execute });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      payload: { command: { commandType: 'artifact.create' } },
    });
    expect(response.statusCode).toBe(202);
    expect(execute).toHaveBeenCalledOnce();
    await app.close();
  });
  it.each([
    ['duplicate', 200],
    ['confirmation_required', 409],
    ['escalated', 409],
    ['denied', 403],
    ['rejected', 400],
  ] as const)('maps %s to an explicit transport status', async (disposition, status) => {
    const app = buildApi({ execute: () => Promise.resolve({ disposition }) });
    const response = await app.inject({ method: 'POST', url: '/v1/commands', payload: {} });
    expect(response.statusCode).toBe(status);
    await app.close();
  });
});
