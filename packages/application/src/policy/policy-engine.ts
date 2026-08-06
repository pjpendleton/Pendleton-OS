import type { Actor, InterfaceContext, ProjectContext } from '@pendleton-os/contracts';

export const POLICY_VERSION = '1.0.0' as const;

export type PolicyOperation =
  | 'information.read'
  | 'information.analyze'
  | 'artifact.create_internal'
  | 'artifact.update_internal'
  | 'communication.draft_external'
  | 'communication.send_external'
  | 'provider.read'
  | 'provider.mutate'
  | 'permission.change'
  | 'resource.delete'
  | 'finance.spend_or_approve'
  | 'legal.commit'
  | 'data.disclose'
  | 'secret.handle'
  | 'operation.bulk_or_cross_project';

export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';
export type PolicyDisposition = 'allow' | 'deny' | 'confirm' | 'escalate';

export interface PolicyEvaluationRequest {
  readonly policyDecisionId: string;
  readonly correlationId: string;
  readonly evaluatedAt: string;
  readonly actor: Actor;
  readonly interfaceContext: InterfaceContext;
  readonly projectContext: ProjectContext;
  readonly operation: string;
  readonly dataClassification: DataClassification;
  readonly exactTarget: boolean;
  readonly grantedScope: boolean;
  readonly verificationAvailable: boolean;
  readonly boundedChange?: boolean;
  readonly voiceConfirmationPermitted?: boolean;
  readonly secondApproverRequired?: boolean;
}

export interface PolicyDecision {
  readonly policyDecisionId: string;
  readonly correlationId: string;
  readonly policyVersion: typeof POLICY_VERSION;
  readonly disposition: PolicyDisposition;
  readonly reasonCodes: readonly string[];
  readonly matchedRuleIds: readonly string[];
  readonly evaluatedAt: string;
  readonly notificationRequired: boolean;
  readonly confirmationRequired: boolean;
  readonly visualReviewRequired: boolean;
  readonly secondApproverRequired: boolean;
  readonly drivingModeHandling: 'execute' | 'brief_only' | 'prepare_and_defer' | 'prohibited';
}

type DecisionFields = Omit<
  PolicyDecision,
  'policyDecisionId' | 'correlationId' | 'policyVersion' | 'evaluatedAt'
>;

const allow = (
  reasonCodes: readonly string[],
  matchedRuleIds: readonly string[],
  notificationRequired = false,
  drivingModeHandling: PolicyDecision['drivingModeHandling'] = 'execute',
): DecisionFields => ({
  disposition: 'allow',
  reasonCodes,
  matchedRuleIds,
  notificationRequired,
  confirmationRequired: false,
  visualReviewRequired: false,
  secondApproverRequired: false,
  drivingModeHandling,
});

const deny = (
  reasonCodes: readonly string[],
  matchedRuleIds: readonly string[],
  prohibited = false,
): DecisionFields => ({
  disposition: 'deny',
  reasonCodes,
  matchedRuleIds,
  notificationRequired: false,
  confirmationRequired: false,
  visualReviewRequired: false,
  secondApproverRequired: false,
  drivingModeHandling: prohibited ? 'prohibited' : 'prepare_and_defer',
});

const confirm = (
  reasonCodes: readonly string[],
  matchedRuleIds: readonly string[],
): DecisionFields => ({
  disposition: 'confirm',
  reasonCodes,
  matchedRuleIds,
  notificationRequired: false,
  confirmationRequired: true,
  visualReviewRequired: false,
  secondApproverRequired: false,
  drivingModeHandling: 'execute',
});

const escalate = (
  reasonCodes: readonly string[],
  matchedRuleIds: readonly string[],
  secondApproverRequired = false,
): DecisionFields => ({
  disposition: 'escalate',
  reasonCodes,
  matchedRuleIds,
  notificationRequired: false,
  confirmationRequired: true,
  visualReviewRequired: true,
  secondApproverRequired,
  drivingModeHandling: 'prepare_and_defer',
});

export class PolicyEngine {
  evaluate(request: PolicyEvaluationRequest): PolicyDecision {
    const fields = this.#evaluateRules(request);
    return Object.freeze({
      policyDecisionId: request.policyDecisionId,
      correlationId: request.correlationId,
      policyVersion: POLICY_VERSION,
      evaluatedAt: request.evaluatedAt,
      ...fields,
    });
  }

  #evaluateRules(request: PolicyEvaluationRequest): DecisionFields {
    if (!request.grantedScope || !request.exactTarget) {
      return deny(
        ['CONTEXT_OR_SCOPE_UNRESOLVED'],
        ['POL-FOUNDATION-DENY-BY-DEFAULT', 'POL-FAIL-CLOSED'],
      );
    }

    if (request.operation === 'secret.handle') {
      return deny(
        ['ORDINARY_SECRET_HANDLING_PROHIBITED'],
        ['POL-OP-015', 'POL-RESTRICTED-DATA'],
        true,
      );
    }

    if (request.dataClassification === 'restricted') {
      return deny(
        ['RESTRICTED_DATA_AUTOMATION_PROHIBITED'],
        ['POL-RESTRICTED-DATA', 'POL-STRICTEST-RULE'],
        true,
      );
    }

    if (request.operation === 'operation.bulk_or_cross_project') {
      return escalate(
        ['BULK_OR_CROSS_PROJECT_REVIEW_REQUIRED'],
        ['POL-OP-016', 'POL-STRICTEST-RULE'],
        request.secondApproverRequired ?? false,
      );
    }

    if (request.operation === 'finance.spend_or_approve' || request.operation === 'legal.commit') {
      return escalate(
        ['HIGH_CONSEQUENCE_REVIEW_REQUIRED'],
        [request.operation === 'legal.commit' ? 'POL-OP-013' : 'POL-OP-012'],
        request.secondApproverRequired ?? request.operation === 'legal.commit',
      );
    }

    if (request.operation === 'data.disclose') {
      if (request.dataClassification === 'confidential') {
        return escalate(
          ['CONFIDENTIAL_DISCLOSURE_REVIEW_REQUIRED'],
          ['POL-OP-014', 'POL-MINIMUM-DISCLOSURE'],
          request.secondApproverRequired ?? false,
        );
      }
      return confirm(['EXTERNAL_DISCLOSURE_CONFIRMATION_REQUIRED'], ['POL-OP-014']);
    }

    if (request.operation === 'permission.change' || request.operation === 'resource.delete') {
      if (request.interfaceContext.drivingMode === true) {
        return escalate(
          ['DRIVING_MODE_VISUAL_REVIEW_REQUIRED'],
          [request.operation === 'permission.change' ? 'POL-OP-010' : 'POL-OP-011'],
        );
      }
      return confirm(
        ['CONSEQUENTIAL_CHANGE_CONFIRMATION_REQUIRED'],
        [request.operation === 'permission.change' ? 'POL-OP-010' : 'POL-OP-011'],
      );
    }

    if (request.operation === 'communication.send_external') {
      if (
        request.interfaceContext.drivingMode === true &&
        request.voiceConfirmationPermitted !== true
      ) {
        return escalate(
          ['DRIVING_MODE_EXTERNAL_SEND_DEFERRED'],
          ['POL-OP-007', 'POL-VOICE-DRIVING'],
        );
      }
      return confirm(['EXTERNAL_SEND_CONFIRMATION_REQUIRED'], ['POL-OP-007']);
    }

    if (request.operation === 'provider.mutate') {
      if (request.interfaceContext.drivingMode === true) {
        return escalate(
          ['DRIVING_MODE_PROVIDER_MUTATION_DEFERRED'],
          ['POL-OP-009', 'POL-VOICE-DRIVING'],
        );
      }
      return confirm(['PROVIDER_MUTATION_CONFIRMATION_REQUIRED'], ['POL-OP-009']);
    }

    if (request.operation === 'artifact.update_internal') {
      if (request.boundedChange !== true || !request.verificationAvailable) {
        return deny(
          ['INTERNAL_UPDATE_CONTROLS_INCOMPLETE'],
          ['POL-OP-005', 'POL-VERIFICATION-REQUIRED'],
        );
      }
      return allow(['BOUNDED_VERIFIABLE_INTERNAL_UPDATE'], ['POL-OP-005']);
    }

    if (request.operation === 'artifact.create_internal') {
      if (!request.verificationAvailable) {
        return deny(
          ['INTERNAL_CREATE_VERIFICATION_UNAVAILABLE'],
          ['POL-OP-004', 'POL-VERIFICATION-REQUIRED'],
        );
      }
      return allow(
        ['INTERNAL_ARTIFACT_CREATE_ALLOWED'],
        ['POL-OP-004'],
        true,
        request.interfaceContext.drivingMode === true ? 'brief_only' : 'execute',
      );
    }

    if (request.operation === 'communication.draft_external') {
      return allow(['DRAFT_ONLY_NO_TRANSMISSION'], ['POL-OP-006']);
    }

    if (
      request.operation === 'information.read' ||
      request.operation === 'information.analyze' ||
      request.operation === 'provider.read'
    ) {
      return allow(
        ['INFORMATIONAL_OPERATION_ALLOWED'],
        [
          request.operation === 'information.read'
            ? 'POL-OP-002'
            : request.operation === 'information.analyze'
              ? 'POL-OP-003'
              : 'POL-OP-008',
        ],
        false,
        request.interfaceContext.drivingMode === true ? 'brief_only' : 'execute',
      );
    }

    return deny(['OPERATION_NOT_CLASSIFIED'], ['POL-FOUNDATION-DENY-BY-DEFAULT']);
  }
}
