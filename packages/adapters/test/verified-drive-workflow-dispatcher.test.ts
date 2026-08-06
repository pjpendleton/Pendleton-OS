import { describe, expect, it } from 'vitest';
import { ArtifactVerifier, EventRecorder, InMemoryEventStore } from '@pendleton-os/application';
import type { Command } from '@pendleton-os/contracts';
import {
  GoogleDriveAdapter,
  VerifiedDriveWorkflowDispatcher,
  type DriveDocument,
  type GoogleDriveClient,
} from '../src/index.js';

const command = {
  commandId: 'command-1',
  commandType: 'artifact.create',
  correlationId: 'correlation-1',
  idempotencyKey: 'key-1',
  issuedAt: '2026-08-06T22:00:00Z',
  actor: { actorId: '018f1f91-6f3d-7c16-bc61-55f9fa334f12', actorType: 'human', roles: ['owner'] },
  interfaceContext: { channel: 'api' },
  projectContext: { projectId: 'pendleton-os', environment: 'test' },
  payload: { title: 'Kernel Brief', text: 'Verified content' },
} as Command;
const policy = {
  policyDecisionId: 'policy-1',
  policyVersion: '1.0.0',
  disposition: 'allow',
  reasonCodes: ['ALLOW_INTERNAL_CREATE'],
  requiredControls: ['independent_verification'],
  evaluatedAt: '2026-08-06T22:00:00Z',
  expiresAt: '2026-08-06T22:05:00Z',
} as const;

const harness = (mismatch = false) => {
  let created: DriveDocument | undefined;
  let createCount = 0;
  const client: GoogleDriveClient = {
    getDocument: () =>
      Promise.resolve(
        created === undefined
          ? undefined
          : { ...created, text: mismatch ? 'tampered' : created.text },
      ),
    searchDocuments: () => Promise.resolve([]),
    createDocument: ({ parentFolderId, name, text }) => {
      createCount += 1;
      created = {
        fileId: 'file-1',
        name,
        text,
        parentIds: [parentFolderId],
        revisionId: '1',
        mimeType: 'application/vnd.google-apps.document',
      };
      return Promise.resolve(created);
    },
    updateDocument: () => Promise.reject(new Error('unused')),
  };
  const store = new InMemoryEventStore();
  let id = 0;
  const dispatcher = new VerifiedDriveWorkflowDispatcher({
    drive: new GoogleDriveAdapter({
      client,
      projects: { getProjectRoot: () => Promise.resolve('root-1') },
    }),
    verifier: new ArtifactVerifier({
      reader: {
        observe: async (fileId) => {
          const doc = await client.getDocument(fileId);
          return doc === undefined
            ? undefined
            : {
                fileId: doc.fileId,
                parentIds: doc.parentIds,
                revisionId: doc.revisionId,
                text: doc.text,
              };
        },
      },
      now: () => new Date('2026-08-06T22:00:01Z'),
      createId: () => `verification-${String(++id)}`,
    }),
    events: new EventRecorder({ store, now: () => new Date('2026-08-06T22:00:02Z') }),
    createId: () => `kernel-${String(++id)}`,
    now: () => new Date('2026-08-06T22:00:03Z'),
  });
  return { dispatcher, store, getCreateCount: () => createCount };
};

describe('verified Drive workflow vertical slice', () => {
  it('mutates, independently verifies, and records an audit chain', async () => {
    const { dispatcher, store, getCreateCount } = harness();
    const result = await dispatcher.dispatch(command, policy);
    expect(getCreateCount()).toBe(1);
    expect((await store.findByWorkflow(result.workflowId)).map((event) => event.eventType)).toEqual(
      [
        'workflow.started',
        'provider.mutation_succeeded',
        'verification.completed',
        'workflow.completed',
      ],
    );
  });
  it('fails closed when independent readback does not match intent', async () => {
    const { dispatcher, store } = harness(true);
    await expect(dispatcher.dispatch(command, policy)).rejects.toThrow(
      'WORKFLOW_VERIFICATION_FAILED',
    );
    expect((await store.findByCorrelation(command.correlationId)).at(-1)?.eventType).toBe(
      'workflow.failed',
    );
  });
});
