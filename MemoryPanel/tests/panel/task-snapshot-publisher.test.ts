import { describe, expect, it } from 'vitest';

import {
  canonicalProjectFromRepoUrl,
  normalizeGitPatch,
  parseSnapshotExcludedPaths,
  snapshotBranchName,
  snapshotRepositoryName,
  validateSnapshotInput,
} from '../../src/panel/services/task-snapshot-publisher.js';
import { assembleTaskPatch } from '../../web/src/pages/WorkbenchPage/components/task-patch.js';

const patch = [
  'diff --git a/src/widget.ts b/src/widget.ts',
  '--- a/src/widget.ts',
  '+++ b/src/widget.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

describe('task snapshot naming and validation', () => {
  it('derives a canonical GitHub project', () => {
    expect(canonicalProjectFromRepoUrl('https://github.com/acme/widgets.git')).toBe('acme/widgets');
    expect(canonicalProjectFromRepoUrl('http://github.com/acme/widgets.git')).toBeUndefined();
    expect(canonicalProjectFromRepoUrl('https://gitlab.com/acme/widgets.git')).toBeUndefined();
  });

  it('uses stable repository and branch names', () => {
    expect(snapshotRepositoryName('tdai-snapshot', 'acme/widgets')).toBe('tdai-snapshot-acme-widgets');
    expect(snapshotBranchName('task-abc123', patch)).toMatch(/^tdai\/task-abc123\/[0-9a-f]{12}$/);
    expect(snapshotBranchName('task-abc123', patch)).toBe(snapshotBranchName('task-abc123', patch));
    expect(snapshotBranchName('task-abc123', patch)).toBe(snapshotBranchName('task-abc123', `${patch}\r\n`));
  });

  it('normalizes harness line endings and terminates the Git patch', () => {
    expect(normalizeGitPatch(patch)).toBe(`${patch}\n`);
    expect(normalizeGitPatch(`${patch.replaceAll('\n', '\r\n')}\r\n`)).toBe(`${patch}\n`);
    expect(normalizeGitPatch('')).toBe('');
  });

  it('assembles mixed collector output with one separator and a final line feed', () => {
    const first = patch.replaceAll('\n', '\r\n') + '\r\n';
    const second = patch.replaceAll('src/widget.ts', 'test/widget.test.ts');
    const assembled = assembleTaskPatch([{ diff: first }, { diff: second }, {}]);

    expect(assembled).toBe(`${patch}\n${second}\n`);
    expect(assembled).not.toContain('\n\ndiff --git');
  });

  it('uses configurable, repository-relative snapshot exclusions', () => {
    expect(parseSnapshotExcludedPaths()).toEqual(['.github/workflows']);
    expect(parseSnapshotExcludedPaths('.github/workflows, generated,generated/')).toEqual([
      '.github/workflows',
      'generated',
    ]);
    expect(() => parseSnapshotExcludedPaths('../outside')).toThrow('相对路径');
  });

  it('accepts a normal task patch', () => {
    expect(() => validateSnapshotInput({
      taskId: 'task-abc123',
      sourceRepoUrl: 'https://github.com/acme/widgets.git',
      canonicalProject: 'acme/widgets',
      baseCommit: '091f4c0e4f3580a8060de5596fa64c1ff9454dc5',
      patch,
    })).not.toThrow();
  });

  it('rejects secret-bearing files and project mismatches', () => {
    const secretPatch = patch.replaceAll('src/widget.ts', '.env');
    expect(() => validateSnapshotInput({
      taskId: 'task-abc123',
      sourceRepoUrl: 'https://github.com/acme/widgets.git',
      canonicalProject: 'acme/widgets',
      baseCommit: '091f4c0e4f3580a8060de5596fa64c1ff9454dc5',
      patch: secretPatch,
    })).toThrow('禁止上传');

    expect(() => validateSnapshotInput({
      taskId: 'task-abc123',
      sourceRepoUrl: 'https://github.com/acme/widgets.git',
      canonicalProject: 'other/widgets',
      baseCommit: '091f4c0e4f3580a8060de5596fa64c1ff9454dc5',
      patch,
    })).toThrow('不一致');
  });
});
