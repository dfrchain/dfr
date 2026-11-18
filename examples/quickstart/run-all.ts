/**
 * Run every quickstart example in order against one deployment.
 *
 *   DFR_API_KEY=... DFR_BASE_URL=... pnpm examples:quickstart
 *
 * Each example is also runnable on its own (`pnpm example:chains`, ...).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const files = ['01-chains.ts', '02-balance-and-tx.ts', '03-errors.ts', '04-usage.ts', '05-events.ts'];

for (const file of files) {
  process.stdout.write(`\n########## ${file} ##########\n`);
  const result = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-strip-types',
      '--experimental-transform-types',
      '--import',
      './scripts/ts-runtime/register.mjs',
      join(here, file),
    ],
    { cwd: repoRoot, env: process.env, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    process.stderr.write(`\n${file} failed with exit code ${String(result.status)}\n`);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write('\nAll quickstart examples completed.\n');
