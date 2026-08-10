import { buildApi } from './index.js';
import { buildProductionRuntime } from './runtime.js';
import { DevicePairingService } from './device-pairing.js';

const start = async (): Promise<void> => {
  const apiToken = process.env.PENDLETON_API_TOKEN;
  if (apiToken === undefined || apiToken.length < 32) {
    throw new Error('PENDLETON_API_TOKEN_REQUIRED');
  }

  const runtime = await buildProductionRuntime();
  const devicePairing = new DevicePairingService(apiToken);
  const app = buildApi(runtime.gateway, {
    apiToken,
    devicePairing: {
      service: devicePairing,
      publicOrigin: process.env.PENDLETON_PUBLIC_ORIGIN ?? 'https://os.peterpendleton.com',
    },
    readiness: runtime.readiness,
    logger: true,
    chatAction: {
      principalId: process.env.PENDLETON_PRINCIPAL_ID ?? 'peter',
      projectId: process.env.PENDLETON_CHAT_PROJECT_ID ?? 'pendleton-os',
    },
    voiceAction: {
      principalId: process.env.PENDLETON_PRINCIPAL_ID ?? 'peter',
      projectId: process.env.PENDLETON_VOICE_PROJECT_ID ?? 'pendleton-os',
    },
    conversation: {
      runtime: runtime.conversations,
      principalId: process.env.PENDLETON_PRINCIPAL_ID ?? 'peter',
      projectId: process.env.PENDLETON_CONVERSATION_PROJECT_ID ?? 'pendleton-os',
    },
    projectRegistry: {
      registry: runtime.projects,
      ownerActorId: process.env.PENDLETON_ACTOR_ID ?? '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
    },
    email: {
      service: runtime.email,
      actorId: process.env.PENDLETON_ACTOR_ID ?? '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
      defaultProjectId: process.env.PENDLETON_EMAIL_PROJECT_ID ?? 'pendleton-os',
    },
    knowledge: {
      service: runtime.knowledge,
      actorId: process.env.PENDLETON_ACTOR_ID ?? '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
      defaultProjectId: process.env.PENDLETON_KNOWLEDGE_PROJECT_ID ?? 'pendleton-os',
    },
    ...(runtime.realtime === undefined
      ? {}
      : {
          realtime: {
            service: runtime.realtime,
            principalId: process.env.PENDLETON_PRINCIPAL_ID ?? 'peter',
          },
        }),
  });
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await runtime.close();
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  await app.listen({ host: '0.0.0.0', port });
};

void start().catch((error: unknown) => {
  console.error('PENDLETON_API_START_FAILED', error);
  process.exitCode = 1;
});
