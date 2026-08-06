import { describe, expect, it } from 'vitest';
import { POLICY_VERSION, PolicyEngine, type PolicyEvaluationRequest } from '../src/index.js';

const baseRequest: PolicyEvaluationRequest = {
  policyDecisionId: '018f1f91-6f3d-7c16-bc61-55f9fa334f30',
  correlationId: '018f1f91-6f3d-7c16-bc61-55f9fa334f31',
  evaluatedAt: '2026-08-06T16:00:00.000Z',
  actor: {
    actorId: '018f1f91-6f3d-7c16-bc61-55f9fa334f12',
    actorType: 'human',
    roles: ['owner'],
  },
  interfaceContext: { channel: 'api', drivingMode: false },
  projectContext: { projectId: 'pendleton-os', environment: 'test' },
  operation: 'information.read',
  dataClassification: 'internal',
  exactTarget: true,
  grantedScope: true,
  verificationAvailable: true,
};

const evaluate = (overrides: Partial<PolicyEvaluationRequest> = {}) =>
  new PolicyEngine().evaluate({ ...baseRequest, ...overrides });

describe('PolicyEngine', () => {
  it('returns a versioned deterministic decision', () => {
    expect(evaluate()).toEqual(evaluate());
    expect(evaluate()).toMatchObject({
      policyVersion: POLICY_VERSION,
      disposition: 'allow',
      matchedRuleIds: ['POL-OP-002'],
    });
  });

  it('allows verified internal creation with notification', () => {
    expect(evaluate({ operation: 'artifact.create_internal' })).toMatchObject({
      disposition: 'allow',
      notificationRequired: true,
      confirmationRequired: false,
    });
  });

  it('allows only bounded and verifiable internal updates', () => {
    expect(
      evaluate({
        operation: 'artifact.update_internal',
        boundedChange: true,
        verificationAvailable: true,
      }),
    ).toMatchObject({ disposition: 'allow', matchedRuleIds: ['POL-OP-005'] });
    expect(
      evaluate({
        operation: 'artifact.update_internal',
        boundedChange: false,
      }),
    ).toMatchObject({ disposition: 'deny', reasonCodes: ['INTERNAL_UPDATE_CONTROLS_INCOMPLETE'] });
  });

  it('requires confirmation for external sending', () => {
    expect(evaluate({ operation: 'communication.send_external' })).toMatchObject({
      disposition: 'confirm',
      confirmationRequired: true,
      visualReviewRequired: false,
    });
  });

  it('defers external sending while driving unless voice confirmation is explicitly permitted', () => {
    expect(
      evaluate({
        operation: 'communication.send_external',
        interfaceContext: { channel: 'voice', drivingMode: true },
      }),
    ).toMatchObject({
      disposition: 'escalate',
      drivingModeHandling: 'prepare_and_defer',
      visualReviewRequired: true,
    });
    expect(
      evaluate({
        operation: 'communication.send_external',
        interfaceContext: { channel: 'voice', drivingMode: true },
        voiceConfirmationPermitted: true,
      }),
    ).toMatchObject({ disposition: 'confirm' });
  });

  it('defers provider mutations while driving', () => {
    expect(
      evaluate({
        operation: 'provider.mutate',
        interfaceContext: { channel: 'voice', drivingMode: true },
      }),
    ).toMatchObject({
      disposition: 'escalate',
      reasonCodes: ['DRIVING_MODE_PROVIDER_MUTATION_DEFERRED'],
    });
  });

  it('escalates financial and legal commitments for visual review', () => {
    expect(evaluate({ operation: 'finance.spend_or_approve' })).toMatchObject({
      disposition: 'escalate',
      confirmationRequired: true,
      visualReviewRequired: true,
    });
    expect(evaluate({ operation: 'legal.commit' })).toMatchObject({
      disposition: 'escalate',
      secondApproverRequired: true,
    });
  });

  it('prohibits ordinary secret handling and restricted-data automation', () => {
    expect(evaluate({ operation: 'secret.handle' })).toMatchObject({
      disposition: 'deny',
      drivingModeHandling: 'prohibited',
    });
    expect(evaluate({ dataClassification: 'restricted' })).toMatchObject({
      disposition: 'deny',
      drivingModeHandling: 'prohibited',
    });
  });

  it('fails closed when scope or target resolution is incomplete', () => {
    expect(evaluate({ grantedScope: false })).toMatchObject({
      disposition: 'deny',
      reasonCodes: ['CONTEXT_OR_SCOPE_UNRESOLVED'],
    });
    expect(evaluate({ exactTarget: false })).toMatchObject({
      disposition: 'deny',
      reasonCodes: ['CONTEXT_OR_SCOPE_UNRESOLVED'],
    });
  });

  it('denies unclassified operations by default', () => {
    expect(evaluate({ operation: 'unknown.operation' })).toMatchObject({
      disposition: 'deny',
      reasonCodes: ['OPERATION_NOT_CLASSIFIED'],
      matchedRuleIds: ['POL-FOUNDATION-DENY-BY-DEFAULT'],
    });
  });

  it('escalates bulk or cross-project work', () => {
    expect(evaluate({ operation: 'operation.bulk_or_cross_project' })).toMatchObject({
      disposition: 'escalate',
      visualReviewRequired: true,
    });
  });
});
