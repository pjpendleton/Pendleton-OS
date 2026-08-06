/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/await-thenable, @typescript-eslint/require-await */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import {
  ArtifactVerifier,
  CommandIntakeService,
  ContextResolutionService,
  EventRecorder,
  InMemoryIdentityDirectory,
  InMemoryProjectDirectory,
  PolicyEngine,
  UnifiedCommandGateway,
  standardCommandCatalog,
} from '../packages/application/dist/index.js';
import {
  GoogleDriveAdapter,
  VerifiedDriveWorkflowDispatcher,
} from '../packages/adapters/dist/index.js';
import {
  PostgresEventStore,
  PostgresIdempotencyRegistry,
  PostgresWorkflowRepository,
  createPostgresPool,
} from '../packages/persistence/dist/index.js';

const secretsDirectory = join(homedir(), 'AppData', 'Local', 'PendletonOS', 'secrets');
const clientFile = JSON.parse(
  await readFile(join(secretsDirectory, 'google-oauth-client.json'), 'utf8'),
);
const tokens = JSON.parse(
  await readFile(join(secretsDirectory, 'google-oauth-token.json'), 'utf8'),
);
const databaseUrl = (await readFile(join(secretsDirectory, 'database-url.txt'), 'utf8')).trim();
const client = clientFile.installed ?? clientFile.web;
if (!client?.client_id || !client?.client_secret || !tokens.refresh_token) {
  throw new Error('GOOGLE_CREDENTIALS_INCOMPLETE');
}

const oauth = new google.auth.OAuth2(client.client_id, client.client_secret);
oauth.setCredentials(tokens);
const driveApi = google.drive({ version: 'v3', auth: oauth });
const docsApi = google.docs({ version: 'v1', auth: oauth });
const pool = createPostgresPool(databaseUrl);

const documentText = (document) =>
  (document.body?.content ?? [])
    .flatMap((item) => item.paragraph?.elements ?? [])
    .map((element) => element.textRun?.content ?? '')
    .join('')
    .replace(/\n$/, '');

const loadDocument = async (fileId) => {
  const [file, document, revisions] = await Promise.all([
    driveApi.files.get({ fileId, fields: 'id,name,mimeType,parents,trashed' }),
    docsApi.documents.get({ documentId: fileId }),
    driveApi.revisions.list({ fileId, fields: 'revisions(id,modifiedTime)' }),
  ]);
  if (file.data.trashed || file.data.mimeType !== 'application/vnd.google-apps.document')
    return undefined;
  const revision = revisions.data.revisions?.at(-1)?.id;
  if (!file.data.id || !file.data.name || !revision)
    throw new Error('DRIVE_OBSERVATION_INCOMPLETE');
  return {
    fileId: file.data.id,
    name: file.data.name,
    mimeType: 'application/vnd.google-apps.document',
    parentIds: file.data.parents ?? [],
    revisionId: revision,
    text: documentText(document.data),
  };
};

const driveClient = {
  getDocument: loadDocument,
  async searchDocuments(parentFolderId, query) {
    const escaped = query.replaceAll("'", "\\'");
    const response = await driveApi.files.list({
      q: `'${parentFolderId}' in parents and name contains '${escaped}' and mimeType='application/vnd.google-apps.document' and trashed=false`,
      fields: 'files(id)',
    });
    return (
      await Promise.all(
        (response.data.files ?? []).map(({ id }) => (id ? loadDocument(id) : undefined)),
      )
    ).filter(Boolean);
  },
  async createDocument({ parentFolderId, name, text }) {
    const created = await driveApi.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.document',
        parents: [parentFolderId],
      },
      fields: 'id',
    });
    if (!created.data.id) throw new Error('DRIVE_CREATE_ID_MISSING');
    if (text.length > 0) {
      await docsApi.documents.batchUpdate({
        documentId: created.data.id,
        requestBody: { requests: [{ insertText: { location: { index: 1 }, text } }] },
      });
    }
    const observed = await loadDocument(created.data.id);
    if (!observed) throw new Error('DRIVE_CREATE_READBACK_FAILED');
    return observed;
  },
  async updateDocument() {
    throw new Error('DRIVE_UPDATE_NOT_IMPLEMENTED');
  },
};

try {
  const folderSearch = await driveApi.files.list({
    q: "name='Pendleton OS Runtime' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id)',
  });
  const rootId = folderSearch.data.files?.[0]?.id;
  if (!rootId) throw new Error('GOOGLE_RUNTIME_FOLDER_NOT_FOUND');

  const events = new PostgresEventStore(pool);
  const workflows = new PostgresWorkflowRepository(pool);
  const driveAdapter = new GoogleDriveAdapter({
    client: driveClient,
    projects: {
      async getProjectRoot(projectId) {
        return projectId === 'pendleton-os' ? rootId : undefined;
      },
    },
  });
  const verifier = new ArtifactVerifier({
    reader: {
      async observe(fileId) {
        return loadDocument(fileId);
      },
    },
    now: () => new Date(),
    createId: randomUUID,
  });
  const dispatcher = new VerifiedDriveWorkflowDispatcher({
    drive: driveAdapter,
    verifier,
    events: new EventRecorder({ store: events }),
    workflows,
    createId: randomUUID,
  });
  const actorId = '018f1f91-6f3d-7c16-bc61-55f9fa334f12';
  const gateway = new UnifiedCommandGateway({
    contexts: new ContextResolutionService({
      identities: new InMemoryIdentityDirectory([
        {
          principalId: 'peter',
          actor: { actorId, actorType: 'human', roles: ['owner'] },
          status: 'active',
        },
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
    workflows: dispatcher,
    createId: randomUUID,
    now: () => new Date(),
  });
  const marker = new Date().toISOString();
  const outcome = await gateway.execute({
    principalId: 'peter',
    project: { projectId: 'pendleton-os' },
    command: {
      commandType: 'artifact.create',
      idempotencyKey: `live-kernel-${randomUUID()}`,
      interfaceContext: { channel: 'automation' },
      payload: {
        title: `Pendleton OS Live Kernel Verification ${marker}`,
        text: `Pendleton OS live Core Kernel verification completed at ${marker}.`,
      },
    },
    policy: {
      operation: 'artifact.create_internal',
      dataClassification: 'internal',
      grantedScope: true,
      verificationAvailable: true,
    },
  });
  if (outcome.disposition !== 'accepted')
    throw new Error(`LIVE_COMMAND_${outcome.disposition.toUpperCase()}`);
  const recorded = await events.findByWorkflow(outcome.workflowId);
  const workflow = await workflows.get(outcome.workflowId);
  const artifactId = recorded.find(({ eventType }) => eventType === 'workflow.completed')?.payload
    .artifactId;
  if (recorded.length !== 4 || workflow?.state !== 'completed' || typeof artifactId !== 'string') {
    throw new Error('LIVE_KERNEL_VERIFICATION_FAILED');
  }
  console.log(
    `LIVE_CORE_KERNEL_VERIFIED commandId=${outcome.commandId} workflowId=${outcome.workflowId} artifactId=${artifactId} events=${recorded.length}`,
  );
} finally {
  await pool.end();
}
