import {
  CONTRACT_VERSION,
  VOICE_CONTRACT_VERSION,
  type VoiceArtifactRequest,
} from '@pendleton-os/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

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
    chatAction?: {
      principalId: string;
      projectId: string;
    };
    voiceAction?: {
      principalId: string;
      projectId: string;
    };
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
  const authorized = (authorization: string | undefined): boolean =>
    options.apiToken === undefined || authorization === `Bearer ${options.apiToken}`;
  const statusForDisposition = (disposition: string): number =>
    disposition === 'accepted'
      ? 202
      : disposition === 'duplicate'
        ? 200
        : disposition === 'confirmation_required' || disposition === 'escalated'
          ? 409
          : disposition === 'denied'
            ? 403
            : 400;
  app.post('/v1/commands', async (request, reply) => {
    if (!authorized(request.headers.authorization)) {
      return reply
        .code(401)
        .send({ disposition: 'rejected', errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    const outcome = await gateway.execute(request.body);
    const disposition =
      typeof outcome === 'object' && outcome !== null && 'disposition' in outcome
        ? String(outcome.disposition)
        : 'internal_error';
    return reply.code(statusForDisposition(disposition)).send(outcome);
  });
  app.post('/v1/chat/artifacts', async (request, reply) => {
    if (!authorized(request.headers.authorization)) {
      return reply
        .code(401)
        .send({ disposition: 'rejected', errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    if (options.chatAction === undefined) {
      return reply.code(503).send({
        disposition: 'rejected',
        errors: [{ code: 'CHAT_ACTION_NOT_CONFIGURED' }],
      });
    }

    const body = request.body;
    const title =
      typeof body === 'object' && body !== null && 'title' in body ? body.title : undefined;
    const text =
      typeof body === 'object' && body !== null && 'text' in body ? body.text : undefined;
    if (typeof title !== 'string' || title.trim().length === 0) {
      return reply.code(400).send({
        disposition: 'rejected',
        errors: [{ code: 'TITLE_REQUIRED', field: 'title' }],
      });
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      return reply.code(400).send({
        disposition: 'rejected',
        errors: [{ code: 'TEXT_REQUIRED', field: 'text' }],
      });
    }

    const outcome = await gateway.execute({
      principalId: options.chatAction.principalId,
      project: { projectId: options.chatAction.projectId },
      command: {
        commandType: 'artifact.create',
        idempotencyKey: `chat-action-${randomUUID()}`,
        interfaceContext: { channel: 'mobile' },
        payload: { title: title.trim(), text: text.trim() },
      },
      policy: {
        operation: 'artifact.create_internal',
        dataClassification: 'internal',
        grantedScope: true,
        verificationAvailable: true,
      },
    });
    return reply.code(202).send(outcome);
  });
  app.get('/v1/voice/capabilities', async (request, reply) => {
    if (!authorized(request.headers.authorization)) {
      return reply
        .code(401)
        .send({ disposition: 'rejected', errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    return {
      contractVersion: VOICE_CONTRACT_VERSION,
      channel: 'voice',
      drivingModeSupported: true,
      interruptionSupported: true,
      actions: ['artifact.create'],
      consequentialActionsRequireConfirmation: true,
    };
  });
  app.post('/v1/voice/artifacts', async (request, reply) => {
    if (!authorized(request.headers.authorization)) {
      return reply
        .code(401)
        .send({ disposition: 'rejected', errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    if (options.voiceAction === undefined) {
      return reply.code(503).send({
        disposition: 'rejected',
        errors: [{ code: 'VOICE_ACTION_NOT_CONFIGURED' }],
      });
    }

    const body = request.body as Partial<VoiceArtifactRequest> | undefined;
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const drivingMode = body?.drivingMode === true;
    const errors: Array<{ code: string; field: string }> = [];
    if (idempotencyKey.length < 8) {
      errors.push({ code: 'IDEMPOTENCY_KEY_REQUIRED', field: 'idempotencyKey' });
    }
    if (title.length === 0) {
      errors.push({ code: 'TITLE_REQUIRED', field: 'title' });
    }
    if (text.length === 0) {
      errors.push({ code: 'TEXT_REQUIRED', field: 'text' });
    }
    if (body?.drivingMode !== undefined && typeof body.drivingMode !== 'boolean') {
      errors.push({ code: 'DRIVING_MODE_INVALID', field: 'drivingMode' });
    }
    if (errors.length > 0) {
      return reply.code(400).send({ disposition: 'rejected', errors });
    }

    const outcome = await gateway.execute({
      principalId: options.voiceAction.principalId,
      project: { projectId: options.voiceAction.projectId },
      command: {
        commandType: 'artifact.create',
        idempotencyKey,
        interfaceContext: { channel: 'voice', drivingMode },
        payload: { title, text },
      },
      policy: {
        operation: 'artifact.create_internal',
        dataClassification: 'internal',
        grantedScope: true,
        verificationAvailable: true,
      },
    });
    const disposition =
      typeof outcome === 'object' && outcome !== null && 'disposition' in outcome
        ? String(outcome.disposition)
        : 'internal_error';
    return reply.code(statusForDisposition(disposition)).send(outcome);
  });
  return app;
};
