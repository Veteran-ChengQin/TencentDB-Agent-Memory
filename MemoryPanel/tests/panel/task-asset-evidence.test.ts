import { describe, expect, it } from 'vitest';
import { hasTaskAssetEvidence } from '../../web/src/services/task-asset-evidence';

describe('hasTaskAssetEvidence', () => {
  it('rejects a pre-created merge plan without execution output', () => {
    expect(hasTaskAssetEvidence({
      artifact_bundle: { session_ids: [], sessions: [] },
      changed_files: [],
      verification: [],
    })).toBe(false);
    expect(hasTaskAssetEvidence({ execution: {} })).toBe(false);
  });

  it.each([
    { execution: { status: 'completed' } },
    { artifact_bundle: { session_ids: ['session-1'] } },
    { artifact_bundle: { sessions: [{ messages: [] }] } },
    { changed_files: [{ path: 'src/index.ts' }] },
    { verification: [{ name: 'pytest' }] },
  ])('accepts actual runner/finalizer evidence: %j', (value) => {
    expect(hasTaskAssetEvidence(value)).toBe(true);
  });
});
