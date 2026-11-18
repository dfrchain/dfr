#!/usr/bin/env node
/**
 * SDK packaging smoke test (developer-product task 03, item 3).
 *
 * Proves the SDK can actually be *installed*, not just imported from the monorepo source:
 *   1. build @dfr/types and @dfr/sdk-typescript to dist/;
 *   2. `pnpm pack` both (publishConfig switches the tarball entry points to dist);
 *   3. extract the tarballs into a clean `node_modules` layout;
 *   4. run a runtime consumer (plain Node ESM) and a TypeScript consumer (`tsc --noEmit`).
 *
 * No registry or network is used: the tarballs are local, so this can run in the offline gate.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = mkdtempSync(join(tmpdir(), 'dfr-sdk-pack-'));

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

function extract(tarball, destination) {
  mkdirSync(destination, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1'], repoRoot);
}

try {
  process.stdout.write('sdk-pack-smoke: building packages...\n');
  run('pnpm', ['--filter', '@dfr/types', 'build'], repoRoot);
  run('pnpm', ['--filter', '@dfr/sdk-typescript', 'build'], repoRoot);

  const packDir = join(workDir, 'tarballs');
  mkdirSync(packDir, { recursive: true });
  process.stdout.write('sdk-pack-smoke: packing tarballs...\n');
  run('pnpm', ['pack', '--pack-destination', packDir], join(repoRoot, 'packages/types'));
  run('pnpm', ['pack', '--pack-destination', packDir], join(repoRoot, 'sdk/typescript'));

  const nodeModules = join(workDir, 'node_modules', '@dfr');
  extract(join(packDir, 'dfr-types-0.1.0.tgz'), join(nodeModules, 'types'));
  extract(join(packDir, 'dfr-sdk-typescript-0.1.0.tgz'), join(nodeModules, 'sdk-typescript'));

  process.stdout.write('sdk-pack-smoke: running Node ESM consumer...\n');
  const runtimeConsumer = join(workDir, 'consumer.mjs');
  writeFileSync(
    runtimeConsumer,
    [
      "import { DFR, isDfrApiError } from '@dfr/sdk-typescript';",
      "const client = new DFR({ apiKey: 'dfr_TestKey1_' + 'a'.repeat(30), baseUrl: 'https://gateway.example' });",
      "if (client.describe() !== 'DFR(baseUrl=https://gateway.example)') throw new Error('unexpected describe()');",
      "if (typeof client.getUsage !== 'function') throw new Error('getUsage missing from dist');",
      "if (typeof client.getLogsPaged !== 'function') throw new Error('getLogsPaged missing from dist');",
      "if (typeof client.getLogsPage !== 'function') throw new Error('getLogsPage missing from dist');",
      "if (typeof isDfrApiError !== 'function') throw new Error('isDfrApiError missing from dist');",
      "process.stdout.write('runtime-consumer-ok\\n');",
      '',
    ].join('\n'),
  );
  const runtimeOutput = execFileSync(process.execPath, [runtimeConsumer], {
    cwd: workDir,
    encoding: 'utf8',
  });
  if (!runtimeOutput.includes('runtime-consumer-ok')) {
    throw new Error('runtime consumer did not complete');
  }

  process.stdout.write('sdk-pack-smoke: type-checking a TypeScript consumer...\n');
  writeFileSync(
    join(workDir, 'consumer.ts'),
    [
      "import { DFR } from '@dfr/sdk-typescript';",
      "import type { UsageResponse } from '@dfr/types';",
      'export async function usage(client: DFR): Promise<UsageResponse> {',
      '  return client.getUsage();',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(workDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    ),
  );
  run(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], workDir);

  process.stdout.write('sdk-pack-smoke: passed (build, pack, install layout, runtime + type consumer)\n');
} finally {
  if (process.env['DFR_KEEP_PACK_SMOKE'] === '1') {
    process.stdout.write(`sdk-pack-smoke: kept work dir ${workDir}\n`);
  } else {
    rmSync(workDir, { recursive: true, force: true });
  }
}
