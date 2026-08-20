/**
 * Runs every *.test.ts in this directory, each in its own process so one
 * failure cannot mask another, and exits non-zero if any suite fails.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith('.test.ts')).sort();

let failed = 0;
for (const file of suites) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(here, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(
  `\n${'='.repeat(56)}\n` +
  (failed === 0
    ? `\x1b[32mALL PASS\x1b[0m — ${suites.length} suites`
    : `\x1b[31m${failed} of ${suites.length} suites FAILED\x1b[0m`),
);
process.exit(failed === 0 ? 0 : 1);
