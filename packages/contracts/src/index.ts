export const CONTRACT_VERSION = '1.0.0' as const;

export const contractNames = [
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
] as const;

export type ContractName = (typeof contractNames)[number];
