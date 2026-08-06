import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const schemaPath = fileURLToPath(new URL('../schemas/pendleton-os.schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(schema);

const actor = {
  actorId: '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
  actorType: 'human',
  roles: ['owner'],
};
const projectContext = { projectId: 'pendleton-os', environment: 'test' };

describe('Pendleton OS core schemas', () => {
  it('compiles every required contract definition', () => {
    const names = [
      'Actor',
      'ProjectContext',
      'Command',
      'PolicyDecision',
      'WorkflowStep',
      'Workflow',
      'Artifact',
      'VerificationResult',
      'Event',
      'PendletonError',
      'IdempotencyRecord',
    ];
    for (const name of names) {
      expect(ajv.getSchema(`${String(schema.$id)}#/$defs/${name}`), name).toBeTypeOf('function');
    }
  });

  it('accepts a canonical command', () => {
    const validate = ajv.getSchema(`${String(schema.$id)}#/$defs/Command`);
    expect(
      validate?.({
        commandId: '018f1f91-6f3d-7c16-bc61-55f9fa334f13',
        correlationId: '018f1f91-6f3d-7c16-bc61-55f9fa334f14',
        idempotencyKey: 'create-doc-001',
        contractVersion: '1.0.0',
        commandType: 'artifact.create',
        actor,
        projectContext,
        interfaceContext: { channel: 'voice', drivingMode: true },
        payload: { title: 'Daily brief' },
        requestedAt: '2026-08-06T14:30:00Z',
      }),
    ).toBe(true);
  });

  it('rejects a command with unresolved actor and project context', () => {
    const validate = ajv.getSchema(`${String(schema.$id)}#/$defs/Command`);
    expect(validate?.({ commandType: 'artifact.create', payload: {} })).toBe(false);
  });

  it('keeps policy outcomes explicit', () => {
    const validate = ajv.getSchema(`${String(schema.$id)}#/$defs/PolicyDecision`);
    expect(
      validate?.({
        policyDecisionId: '018f1f91-6f3d-7c16-bc61-55f9fa334f15',
        policyVersion: '1.0.0',
        disposition: 'confirm',
        reasonCodes: ['VOICE_CONSEQUENTIAL_ACTION'],
        decidedAt: '2026-08-06T14:30:01Z',
      }),
    ).toBe(true);
  });
});
