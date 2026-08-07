import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactVerifier,
  ConversationRuntime,
  CommandIntakeService,
  ContextResolutionService,
  EventRecorder,
  InMemoryIdentityDirectory,
  InMemoryProjectDirectory,
  PolicyEngine,
  RealtimeConversationService,
  UnifiedCommandGateway,
  standardCommandCatalog,
} from '@pendleton-os/application';
import {
  GoogleApisDriveClient,
  GoogleDriveAdapter,
  OpenAIRealtimeProvider,
  VerifiedDriveWorkflowDispatcher,
  createGoogleOAuthClient,
} from '@pendleton-os/adapters';
import {
  PostgresEventStore,
  PostgresConversationRepository,
  PostgresIdempotencyRegistry,
  PostgresWorkflowRepository,
  createPostgresPool,
} from '@pendleton-os/persistence';

interface OAuthClientFile {
  installed?: OAuthClient;
  web?: OAuthClient;
}
interface OAuthClient {
  client_id: string;
  client_secret: string;
}

const decodeJson = (value: string): unknown =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;

const secretText = async (environmentName: string, fileName: string): Promise<string> => {
  const fromEnvironment = process.env[environmentName];
  if (fromEnvironment !== undefined) return fromEnvironment;
  return readFile(join(homedir(), 'AppData', 'Local', 'PendletonOS', 'secrets', fileName), 'utf8');
};

export interface ProductionRuntime {
  readonly gateway: UnifiedCommandGateway;
  readonly conversations: ConversationRuntime;
  readonly realtime: RealtimeConversationService | undefined;
  readonly readiness: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}

export const buildProductionRuntime = async (): Promise<ProductionRuntime> => {
  const databaseUrl = (await secretText('DATABASE_URL', 'database-url.txt')).trim();
  const clientFile = process.env.GOOGLE_OAUTH_CLIENT_BASE64
    ? (decodeJson(process.env.GOOGLE_OAUTH_CLIENT_BASE64) as OAuthClientFile)
    : (JSON.parse(
        await secretText('GOOGLE_OAUTH_CLIENT_JSON', 'google-oauth-client.json'),
      ) as OAuthClientFile);
  const tokens = process.env.GOOGLE_OAUTH_TOKEN_BASE64
    ? (decodeJson(process.env.GOOGLE_OAUTH_TOKEN_BASE64) as object)
    : (JSON.parse(
        await secretText('GOOGLE_OAUTH_TOKEN_JSON', 'google-oauth-token.json'),
      ) as object);
  const oauthClient = clientFile.installed ?? clientFile.web;
  if (!oauthClient?.client_id || !oauthClient.client_secret)
    throw new Error('GOOGLE_CLIENT_INVALID');
  const rootId = process.env.GOOGLE_DRIVE_ROOT_ID ?? '10IWtfsRSvgiUuN1CrE3nZvFW2XXRRS49';
  const actorId = process.env.PENDLETON_ACTOR_ID ?? '018f1f91-6f3d-7c16-bc61-55f9fa334f12';
  const principalId = process.env.PENDLETON_PRINCIPAL_ID ?? 'peter';
  const pool = createPostgresPool(databaseUrl);
  const driveClient = new GoogleApisDriveClient(createGoogleOAuthClient(oauthClient, tokens));
  const events = new PostgresEventStore(pool);
  const conversations = new ConversationRuntime(
    new PostgresConversationRepository(pool),
    randomUUID,
    () => new Date(),
  );
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const realtime =
    openAiApiKey === undefined
      ? undefined
      : new RealtimeConversationService(conversations, new OpenAIRealtimeProvider(openAiApiKey), {
          model: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1',
          voice: process.env.OPENAI_REALTIME_VOICE ?? 'marin',
        });
  const workflows = new PostgresWorkflowRepository(pool);
  const gateway = new UnifiedCommandGateway({
    contexts: new ContextResolutionService({
      identities: new InMemoryIdentityDirectory([
        { principalId, actor: { actorId, actorType: 'human', roles: ['owner'] }, status: 'active' },
      ]),
      projects: new InMemoryProjectDirectory([
        {
          projectId: 'pendleton-os',
          aliases: ['os'],
          environment: 'production',
          status: 'active',
          authorizedActorIds: [actorId],
          resourceIds: [],
        },
      ]),
    }),
    intake: new CommandIntakeService({
      catalog: standardCommandCatalog,
      idempotencyRegistry: new PostgresIdempotencyRegistry(pool),
    }),
    policy: new PolicyEngine(),
    workflows: new VerifiedDriveWorkflowDispatcher({
      drive: new GoogleDriveAdapter({
        client: driveClient,
        projects: {
          getProjectRoot: (projectId) =>
            Promise.resolve(projectId === 'pendleton-os' ? rootId : undefined),
        },
      }),
      verifier: new ArtifactVerifier({
        reader: driveClient,
        now: () => new Date(),
        createId: randomUUID,
      }),
      events: new EventRecorder({ store: events }),
      workflows,
      createId: randomUUID,
    }),
    createId: randomUUID,
    now: () => new Date(),
  });
  const readiness = async (): Promise<boolean> => {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  };
  if (!(await readiness())) throw new Error('DATABASE_NOT_READY');
  return {
    gateway,
    conversations,
    realtime,
    readiness,
    close: async () => {
      await pool.end();
    },
  };
};
