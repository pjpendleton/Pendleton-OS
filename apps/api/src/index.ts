import {
  CONTRACT_VERSION,
  VOICE_CONTRACT_VERSION,
  type VoiceArtifactRequest,
} from '@pendleton-os/contracts';
import type { ConversationRuntime, RealtimeConversationService } from '@pendleton-os/application';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { type DevicePairingService } from './device-pairing.js';
import { pairingAdminPage, pairingClaimPage } from './pairing-client-pages.js';
import { voiceClientPage } from './voice-client-page.js';

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
    devicePairing?: {
      service: DevicePairingService;
      publicOrigin: string;
    };
    chatAction?: {
      principalId: string;
      projectId: string;
    };
    voiceAction?: {
      principalId: string;
      projectId: string;
    };
    conversation?: {
      runtime: ConversationRuntime;
      principalId: string;
      projectId: string;
    };
    realtime?: {
      service: RealtimeConversationService;
      principalId: string;
    };
  } = {},
): FastifyInstance => {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
  });
  app.addContentTypeParser('application/sdp', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });
  app.get('/health/live', () => ({ status: 'alive' }));
  app.get('/voice', (_request, reply) => reply.type('text/html').send(voiceClientPage));
  app.get('/pair', (_request, reply) =>
    reply.header('cache-control', 'no-store').type('text/html').send(pairingAdminPage),
  );
  app.get('/pair/claim', (_request, reply) =>
    reply.header('cache-control', 'no-store').type('text/html').send(pairingClaimPage),
  );
  app.get('/health/ready', async (_request, reply) => {
    const ready = (await options.readiness?.()) ?? true;
    return ready ? kernelStatus : reply.code(503).send({ ...kernelStatus, status: 'unavailable' });
  });
  const administratorAuthorized = (authorization: string | undefined): boolean =>
    options.apiToken === undefined || authorization === `Bearer ${options.apiToken}`;
  const authorized = (headers: {
    authorization?: string | undefined;
    cookie?: string | undefined;
  }): boolean =>
    administratorAuthorized(headers.authorization) ||
    (options.devicePairing?.service.verifySession(
      options.devicePairing.service.cookieFromHeader(headers.cookie),
    ) ??
      false);
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
  app.get('/v1/auth/session', async (request, reply) => {
    if (!authorized(request.headers)) {
      return reply.code(401).send({ authenticated: false });
    }
    return { authenticated: true };
  });
  app.post('/v1/auth/logout', async (_request, reply) => {
    if (options.devicePairing !== undefined) {
      reply.header('set-cookie', options.devicePairing.service.clearSessionCookie());
    }
    return reply.code(204).send();
  });
  app.post('/v1/device-pairings', async (request, reply) => {
    if (!administratorAuthorized(request.headers.authorization)) {
      return reply.code(401).send({ errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    if (options.devicePairing === undefined) {
      return reply.code(503).send({ errors: [{ code: 'DEVICE_PAIRING_NOT_CONFIGURED' }] });
    }
    const pairing = options.devicePairing.service.createPairing();
    const claimUrl = `${options.devicePairing.publicOrigin}/pair/claim#token=${encodeURIComponent(pairing.token)}`;
    const qrCodeDataUrl = await QRCode.toDataURL(claimUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
    request.log.info(
      { pairingId: pairing.pairingId, expiresAt: pairing.expiresAt },
      'device_pairing_created',
    );
    return reply.header('cache-control', 'no-store').code(201).send({
      pairingId: pairing.pairingId,
      claimUrl,
      qrCodeDataUrl,
      expiresAt: pairing.expiresAt,
    });
  });
  app.post('/v1/device-pairings/claim', async (request, reply) => {
    if (options.devicePairing === undefined) {
      return reply.code(503).send({ errors: [{ code: 'DEVICE_PAIRING_NOT_CONFIGURED' }] });
    }
    const body = request.body as { token?: unknown } | undefined;
    if (typeof body?.token !== 'string' || body.token.length < 50 || body.token.length > 200) {
      return reply.code(400).send({ errors: [{ code: 'DEVICE_PAIRING_INVALID' }] });
    }
    try {
      const session = options.devicePairing.service.claimPairing(body.token);
      request.log.info({ expiresAt: session.expiresAt }, 'device_pairing_claimed');
      return await reply
        .header('cache-control', 'no-store')
        .header('set-cookie', options.devicePairing.service.sessionCookie(session.cookieValue))
        .code(201)
        .send({ paired: true, expiresAt: session.expiresAt });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DEVICE_PAIRING_INVALID';
      return reply.code(code === 'DEVICE_PAIRING_EXPIRED' ? 410 : 400).send({ errors: [{ code }] });
    }
  });
  app.post('/v1/commands', async (request, reply) => {
    if (!authorized(request.headers)) {
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
    if (!authorized(request.headers)) {
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
    if (!authorized(request.headers)) {
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
    if (!authorized(request.headers)) {
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
  app.post('/v1/conversations', async (request, reply) => {
    if (!authorized(request.headers)) {
      return reply.code(401).send({ errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    if (options.conversation === undefined) {
      return reply.code(503).send({ errors: [{ code: 'CONVERSATION_NOT_CONFIGURED' }] });
    }
    const body = request.body as { channel?: unknown; drivingMode?: unknown } | undefined;
    const channel = body?.channel;
    if (channel !== 'voice' && channel !== 'mobile' && channel !== 'web') {
      return reply.code(400).send({ errors: [{ code: 'CONVERSATION_CHANNEL_INVALID' }] });
    }
    if (body?.drivingMode !== undefined && typeof body.drivingMode !== 'boolean') {
      return reply.code(400).send({ errors: [{ code: 'DRIVING_MODE_INVALID' }] });
    }
    const session = await options.conversation.runtime.start({
      principalId: options.conversation.principalId,
      projectId: options.conversation.projectId,
      channel,
      drivingMode: body?.drivingMode === true,
    });
    return reply.code(201).send(session);
  });
  app.get('/v1/conversations/:sessionId', async (request, reply) => {
    if (!authorized(request.headers)) {
      return reply.code(401).send({ errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    if (options.conversation === undefined) {
      return reply.code(503).send({ errors: [{ code: 'CONVERSATION_NOT_CONFIGURED' }] });
    }
    const { sessionId } = request.params as { sessionId: string };
    try {
      return await options.conversation.runtime.resume(sessionId, options.conversation.principalId);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CONVERSATION_INTERNAL_ERROR';
      return reply
        .code(code === 'CONVERSATION_ACCESS_DENIED' ? 403 : 404)
        .send({ errors: [{ code }] });
    }
  });
  app.post('/v1/conversations/:sessionId/turns', async (request, reply) => {
    if (!authorized(request.headers)) {
      return reply.code(401).send({ errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    if (options.conversation === undefined) {
      return reply.code(503).send({ errors: [{ code: 'CONVERSATION_NOT_CONFIGURED' }] });
    }
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as Record<string, unknown> | undefined;
    const role = body?.role;
    const kind = body?.kind;
    const text = typeof body?.text === 'string' ? body.text : '';
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
      return reply.code(400).send({ errors: [{ code: 'CONVERSATION_ROLE_INVALID' }] });
    }
    if (
      kind !== 'message' &&
      kind !== 'action_proposal' &&
      kind !== 'action_result' &&
      kind !== 'summary'
    ) {
      return reply.code(400).send({ errors: [{ code: 'CONVERSATION_KIND_INVALID' }] });
    }
    if (idempotencyKey.length < 8) {
      return reply.code(400).send({ errors: [{ code: 'IDEMPOTENCY_KEY_REQUIRED' }] });
    }
    try {
      const turn = await options.conversation.runtime.append({
        sessionId,
        principalId: options.conversation.principalId,
        role,
        kind,
        text,
        idempotencyKey,
      });
      return await reply.code(201).send(turn);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CONVERSATION_INTERNAL_ERROR';
      const status =
        code === 'CONVERSATION_ACCESS_DENIED' ? 403 : code === 'CONVERSATION_NOT_FOUND' ? 404 : 409;
      return reply.code(status).send({ errors: [{ code }] });
    }
  });
  app.post('/v1/conversations/:sessionId/close', async (request, reply) => {
    if (!authorized(request.headers)) {
      return reply.code(401).send({ errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    if (options.conversation === undefined) {
      return reply.code(503).send({ errors: [{ code: 'CONVERSATION_NOT_CONFIGURED' }] });
    }
    const { sessionId } = request.params as { sessionId: string };
    try {
      return await options.conversation.runtime.close(sessionId, options.conversation.principalId);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CONVERSATION_INTERNAL_ERROR';
      return reply
        .code(code === 'CONVERSATION_ACCESS_DENIED' ? 403 : 404)
        .send({ errors: [{ code }] });
    }
  });
  app.post('/v1/conversations/:sessionId/realtime', async (request, reply) => {
    if (!authorized(request.headers)) {
      return reply.code(401).send({ errors: [{ code: 'AUTHENTICATION_REQUIRED' }] });
    }
    if (options.realtime === undefined) {
      return reply.code(503).send({ errors: [{ code: 'REALTIME_NOT_CONFIGURED' }] });
    }
    const { sessionId } = request.params as { sessionId: string };
    if (typeof request.body !== 'string') {
      return reply.code(400).send({ errors: [{ code: 'REALTIME_SDP_REQUIRED' }] });
    }
    try {
      const answer = await options.realtime.service.connect(
        sessionId,
        options.realtime.principalId,
        request.body,
      );
      if (answer.location !== undefined)
        reply.header('x-pendleton-realtime-location', answer.location);
      return await reply.type('application/sdp').send(answer.sdp);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'REALTIME_INTERNAL_ERROR';
      const status =
        code === 'CONVERSATION_ACCESS_DENIED'
          ? 403
          : code === 'CONVERSATION_NOT_FOUND'
            ? 404
            : code.startsWith('OPENAI_REALTIME_ERROR')
              ? 502
              : 400;
      return reply.code(status).send({ errors: [{ code }] });
    }
  });
  return app;
};
