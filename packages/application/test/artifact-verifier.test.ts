import { describe, expect, it } from 'vitest';
import { ArtifactVerifier, type ArtifactObservationReader } from '../src/index.js';

const expected = { fileId: 'file-1', projectRootId: 'folder-root', expectedText: 'Hello' };
const create = (reader: ArtifactObservationReader) =>
  new ArtifactVerifier({
    reader,
    now: () => new Date('2026-08-06T19:00:00Z'),
    createId: () => 'verification-1',
  });

describe('ArtifactVerifier', () => {
  it('verifies matching independently observed state', async () => {
    const result = await create({
      observe: () =>
        Promise.resolve({
          fileId: 'file-1',
          parentIds: ['folder-root'],
          revisionId: 'rev-1',
          text: 'Hello',
        }),
    }).verify(expected);
    expect(result).toMatchObject({
      disposition: 'verified',
      reasonCodes: ['OBSERVED_STATE_MATCHES_INTENT'],
      verifiedAt: '2026-08-06T19:00:00.000Z',
    });
  });
  it('reports mismatched content or location', async () => {
    const result = await create({
      observe: () =>
        Promise.resolve({
          fileId: 'file-1',
          parentIds: ['outside'],
          revisionId: 'rev-1',
          text: 'Wrong',
        }),
    }).verify(expected);
    expect(result).toMatchObject({
      disposition: 'mismatch',
      observations: { mismatches: ['projectRootId', 'contentHash'] },
    });
  });
  it('reports unavailable evidence without claiming success', async () => {
    expect(
      await create({ observe: () => Promise.resolve(undefined) }).verify(expected),
    ).toMatchObject({ disposition: 'evidence_unavailable' });
    expect(
      await create({ observe: () => Promise.reject(new Error('provider down')) }).verify(expected),
    ).toMatchObject({ disposition: 'evidence_unavailable' });
  });
  it('reports partial observations distinctly', async () => {
    const result = await create({
      observe: () => Promise.resolve({ fileId: 'file-1', parentIds: ['folder-root'] }),
    }).verify(expected);
    expect(result).toMatchObject({
      disposition: 'partial',
      observations: { missing: ['revisionId', 'text'] },
    });
  });
  it('requires an update revision to advance', async () => {
    const result = await create({
      observe: () =>
        Promise.resolve({
          fileId: 'file-1',
          parentIds: ['folder-root'],
          revisionId: 'rev-1',
          text: 'Hello',
        }),
    }).verify({ ...expected, minimumRevisionId: 'rev-1' });
    expect(result).toMatchObject({
      disposition: 'mismatch',
      observations: { mismatches: ['revisionNotAdvanced'] },
    });
  });
});
