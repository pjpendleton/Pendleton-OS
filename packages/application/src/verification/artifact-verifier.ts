import { createHash } from 'node:crypto';

export interface ExpectedArtifactState {
  readonly fileId: string;
  readonly projectRootId: string;
  readonly expectedText: string;
  readonly minimumRevisionId?: string;
}

export interface ArtifactObservation {
  readonly fileId: string;
  readonly parentIds: readonly string[];
  readonly revisionId?: string;
  readonly text?: string;
}

export interface ArtifactObservationReader {
  observe(fileId: string): Promise<ArtifactObservation | undefined>;
}

export interface VerificationResult {
  readonly verificationId: string;
  readonly disposition:
    | 'verified'
    | 'mismatch'
    | 'evidence_unavailable'
    | 'partial'
    | 'not_required';
  readonly method: 'independent_readback';
  readonly observations: Readonly<Record<string, unknown>>;
  readonly reasonCodes: readonly string[];
  readonly verifiedAt: string;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

export class ArtifactVerifier {
  readonly #reader: ArtifactObservationReader;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: {
    reader: ArtifactObservationReader;
    now: () => Date;
    createId: () => string;
  }) {
    this.#reader = options.reader;
    this.#now = options.now;
    this.#createId = options.createId;
  }

  async verify(expected: ExpectedArtifactState): Promise<VerificationResult> {
    let observation: ArtifactObservation | undefined;
    try {
      observation = await this.#reader.observe(expected.fileId);
    } catch {
      return this.#result('evidence_unavailable', ['OBSERVATION_FAILED'], {
        fileId: expected.fileId,
      });
    }
    if (observation === undefined) {
      return this.#result('evidence_unavailable', ['ARTIFACT_NOT_OBSERVED'], {
        fileId: expected.fileId,
      });
    }
    const observedRevisionId = observation.revisionId;
    const observedText = observation.text;
    const missing: string[] = [];
    if (observedRevisionId === undefined) missing.push('revisionId');
    if (observedText === undefined) missing.push('text');
    if (missing.length > 0) {
      return this.#result('partial', ['OBSERVATION_INCOMPLETE'], {
        fileId: observation.fileId,
        missing,
      });
    }
    if (observedRevisionId === undefined || observedText === undefined) {
      throw new Error('Verification narrowing invariant failed.');
    }
    const mismatches: string[] = [];
    if (observation.fileId !== expected.fileId) mismatches.push('fileId');
    if (!observation.parentIds.includes(expected.projectRootId)) mismatches.push('projectRootId');
    if (hash(observedText) !== hash(expected.expectedText)) mismatches.push('contentHash');
    if (
      expected.minimumRevisionId !== undefined &&
      observedRevisionId === expected.minimumRevisionId
    ) {
      mismatches.push('revisionNotAdvanced');
    }
    if (mismatches.length > 0) {
      return this.#result('mismatch', ['OBSERVED_STATE_MISMATCH'], {
        fileId: observation.fileId,
        revisionId: observedRevisionId,
        mismatches,
        observedContentHash: hash(observedText),
        expectedContentHash: hash(expected.expectedText),
      });
    }
    return this.#result('verified', ['OBSERVED_STATE_MATCHES_INTENT'], {
      fileId: observation.fileId,
      revisionId: observedRevisionId,
      parentIds: observation.parentIds,
      contentHash: hash(observedText),
    });
  }

  #result(
    disposition: VerificationResult['disposition'],
    reasonCodes: readonly string[],
    observations: Readonly<Record<string, unknown>>,
  ): VerificationResult {
    return {
      verificationId: this.#createId(),
      disposition,
      method: 'independent_readback',
      observations,
      reasonCodes,
      verifiedAt: this.#now().toISOString(),
    };
  }
}
