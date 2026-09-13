/**
 * Backward-compatible entry point.
 *
 * Asset collection used to be implemented in this case directory and was
 * therefore coupled to Doc2Feat #2643. New runs use the shared finalizer; this
 * wrapper remains so older commands fail clearly instead of silently skipping
 * TDAI synchronization.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeTaskRun } from '../../../lib/task-run-finalizer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = resolve(here, '..');
const runtimeDir = resolve(process.env.DOC2FEAT_RUNTIME_DIR ?? resolve(caseRoot, 'artifacts/runtime'));
const manifestPath = resolve(runtimeDir, 'run-manifest.json');

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch {
  throw new Error(`run-manifest.json is required; case-specific collection has been removed: ${manifestPath}`);
}

const result = await finalizeTaskRun({ manifest, manifestDir: dirname(manifestPath) });
console.log(JSON.stringify({
  task_id: result.context.task_id,
  status: result.task?.status,
  session_id: result.sessionSummary.session_id,
  verification_passed: result.verificationPassed,
  changed_files: result.deposition.changed_files.length,
}, null, 2));
