/**
 * OpenAPI semantic-gate contract test (DFR-M1-A03).
 *
 * See docs/architecture/m1-api-contract.md §7 and docs/development/m1-taskbook.md.
 *
 * Purpose: prove the OpenAPI gate in `pnpm verify` does **more** than check that `$ref` resolves.
 * Hand-written assertions in spec-consistency.test.ts cannot cover the "semantically invalid but syntactically
 * parseable" category, so this file uses behavioural tests (actually running the linter) to prove:
 *   1. The current spec passes;
 *   2. Duplicate operationIds are caught;
 *   3. Illegal schemas are caught.
 *
 * The negative controls mutate the same minimal baseline document, avoiding false positives from
 * "it failed because the document itself had some other error".
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);

interface LintOutcome {
  readonly ok: boolean;
  readonly output: string;
}

/**
 * Calls the gate via the real script, capturing the exit code instead of throwing.
 *
 * Deliberately uses **async** execFile: the sync version would block the event loop, making the multiple probes
 * under `describe.concurrent` degrade to serial and slowing the default test gate.
 */
async function runLint(specPath: string): Promise<LintOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync('./scripts/lint-openapi.sh', [specPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * A minimal but semantically valid OpenAPI 3.1 document; negative controls make only a **single** mutation on top of it.
 *
 * The `extraPaths` injection point sits below `paths:` and above `components:`, ensuring the mutation lands at
 * the right level — otherwise it would fail with a "structural error" instead of the "target rule",
 * and the negative control would lose its meaning.
 */
function makeProbeSpec(extraPaths = ''): string {
  return `openapi: 3.1.0
info:
  title: DFR lint probe
  version: 1.0.0
  license: { name: Proprietary }
servers:
  - url: https://probe.dfr.local
security:
  - ProbeKey: []
paths:
  /probe:
    get:
      summary: Probe operation
      operationId: probeOnce
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Probe'
${extraPaths}components:
  securitySchemes:
    ProbeKey:
      type: apiKey
      in: header
      name: X-Probe-Key
  schemas:
    Probe:
      type: object
      required: [ok]
      properties:
        ok: { type: boolean }
`;
}

const baselineSpec = makeProbeSpec();

function writeProbe(dir: string, name: string, body: string): string {
  const target = join(dir, name);
  writeFileSync(target, body, 'utf8');
  return target;
}

describe('OpenAPI semantic-gate wiring (DFR-M1-A03)', () => {
  it('package.json exposes lint:openapi and verify runs it', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['lint:openapi'], 'missing lint:openapi script').toBeTruthy();
    expect(pkg.scripts.verify, 'verify has not wired in the OpenAPI semantic gate').toContain('lint:openapi');
  });

  it('the gate tool version is pinned exactly (not a version range)', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const pinned = pkg.devDependencies['@redocly/cli'];
    expect(pinned, 'missing @redocly/cli').toBeTruthy();
    // Exact version: no ^ ~ or range symbols, so the rule set cannot drift as the tool upgrades.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe.concurrent('OpenAPI semantic-gate behaviour (DFR-M1-A03)', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'dfr-openapi-lint-'));

  it('the current real spec passes the gate', async () => {
    const outcome = await runLint('docs/api/openapi.yaml');
    expect(outcome.ok, `The spec failed the semantic gate:\n${outcome.output}`).toBe(true);
  }, 60_000);

  it('the minimal baseline document itself passes (the control for the negative controls)', async () => {
    const outcome = await runLint(writeProbe(workDir, 'baseline.yaml', baselineSpec));
    expect(outcome.ok, `The baseline probe document is invalid, so the negative controls cannot be trusted:\n${outcome.output}`).toBe(true);
  }, 60_000);

  it('a duplicate operationId is caught', async () => {
    // Single mutation: add a path with an operationId identical to the existing operation.
    const duplicated = makeProbeSpec(`  /probe-duplicate:
    get:
      summary: Probe duplicate operation
      operationId: probeOnce
      responses:
        '200':
          description: ok
`);
    const outcome = await runLint(
      writeProbe(workDir, 'duplicate-operation-id.yaml', duplicated),
    );
    expect(outcome.ok, 'a duplicate operationId was not caught').toBe(false);
    expect(outcome.output).toMatch(/operation-operationId-unique|operationId/i);
  }, 60_000);

  it('an illegal schema type is caught', async () => {
    const invalid = baselineSpec.replace(
      '        ok: { type: boolean }',
      '        ok: { type: boolean-not-a-type }',
    );
    const outcome = await runLint(writeProbe(workDir, 'invalid-schema.yaml', invalid));
    expect(outcome.ok, 'an illegal schema was not caught').toBe(false);
    expect(outcome.output).toMatch(/type|schema/i);
  }, 60_000);
});
