#!/usr/bin/env node
/**
 * Issue a DFR API Key (developer-product task 03).
 *
 * Usage:
 *   DFR_M0_API_KEY_PEPPER=... node --experimental-strip-types --experimental-transform-types \
 *     --import ./scripts/ts-runtime/register.mjs scripts/issue-api-key.ts \
 *     [--project <id>] [--key-id <AbCd1234>] [--json]
 *
 * Output shows the plaintext key **once**; only the hash belongs in deployment configuration.
 * The script never writes to disk and never prints the pepper value.
 */
import { pathToFileURL } from 'node:url';
import { issueApiKey } from '../apps/gateway/src/api-key.ts';

function parseArgs(argv: readonly string[]): { project?: string; keyId?: string; json: boolean } {
  const parsed: { project?: string; keyId?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--project requires a value');
      parsed.project = value;
      i += 1;
    } else if (arg === '--key-id') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--key-id requires a value');
      parsed.keyId = value;
      i += 1;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: DFR_M0_API_KEY_PEPPER=<pepper> issue-api-key.ts [--project <id>] [--key-id <8 chars>] [--json]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const pepper = process.env['DFR_M0_API_KEY_PEPPER'];
  if (pepper === undefined || pepper === '') {
    process.stderr.write(
      'issue-api-key: set DFR_M0_API_KEY_PEPPER to the target deployment pepper\n',
    );
    process.exit(1);
  }
  if (args.project !== undefined && args.project.trim() === '') {
    throw new Error('--project must be non-empty');
  }
  const issued = issueApiKey({
    pepper,
    ...(args.keyId !== undefined ? { keyId: args.keyId } : {}),
    ...(args.project !== undefined ? { projectId: args.project } : {}),
  });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          apiKey: issued.apiKey,
          keyId: issued.keyId,
          hash: issued.hash,
          ...(issued.projectId !== undefined ? { projectId: issued.projectId } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    [
      '# DFR API key — the plaintext key is shown ONCE. Store it in your secret manager.',
      `DFR_API_KEY=${issued.apiKey}`,
      '',
      '# Deployment configuration (the plaintext key is never stored by the Gateway):',
      `export DFR_M0_API_KEY_ID=${issued.keyId}`,
      `export DFR_M0_API_KEY_HASH=${issued.hash}`,
      '# Keep using the deployment pepper you passed in; it is not printed.',
      ...(issued.projectId !== undefined ? [`# project: ${issued.projectId}`] : []),
      '',
    ].join('\n'),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`issue-api-key: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
