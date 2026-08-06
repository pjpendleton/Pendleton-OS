import { CONTRACT_VERSION } from '@pendleton-os/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

export const kernelStatus = Object.freeze({
  service: 'pendleton-os-api',
  contractVersion: CONTRACT_VERSION,
  status: 'ready',
});

export const buildApi = (
  gateway: { execute(request: unknown): Promise<unknown> },
  options: {
    apiToken?: string;
    readiness?: () => Promise<boolean>;
    logger?: boolean;
  } = {},
): FastifyInstance => {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
  });
  app.get('/health/live', () => ({ status: 'alive' }));
  app.get('/health/ready', async (_request, reply) => {
    const ready = (await options.readiness?.()) ?? true;
    return ready ? kernelStatus : reply.code(503).send({ ...kernelStatus, status: 'unavailable' });
  });
  app.post('/v1/commands', async (request, reply) => {
    if (
      options.apiToken !== undefined &&
      request.headers.authorization !== `Bearer ${options.apiToken}`
    ) {
      return reply
        .code(401)
        .send({ disposition: 'rejected', errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    const outcome = await gateway.execute(request.body);
    const disposition =
      typeof outcome === 'object' && outcome !== null && 'disposition' in outcome
        ? String(outcome.disposition)
        : 'internal_error';
    const status =
      disposition === 'accepted'
        ? 202
        : disposition === 'duplicate'
          ? 200
          : disposition === 'confirmation_required' || disposition === 'escalated'
            ? 409
            : disposition === 'denied'
              ? 403
              : 400;
    return reply.code(status).send(outcome);
  });
  return app;
};
