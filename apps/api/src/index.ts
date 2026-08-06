import {
  CommandIntakeService,
  InMemoryIdempotencyRegistry,
  standardCommandCatalog,
} from '@pendleton-os/application';
import { CONTRACT_VERSION } from '@pendleton-os/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

export const kernelStatus = Object.freeze({
  service: 'pendleton-os-api',
  contractVersion: CONTRACT_VERSION,
  status: 'foundation',
});

export const commandIntake = new CommandIntakeService({
  catalog: standardCommandCatalog,
  idempotencyRegistry: new InMemoryIdempotencyRegistry(),
});

export const buildApi = (gateway: {
  execute(request: unknown): Promise<unknown>;
}): FastifyInstance => {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, requestTimeout: 30_000 });
  app.post('/v1/commands', async (request, reply) => {
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
