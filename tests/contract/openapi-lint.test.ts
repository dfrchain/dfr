/**
 * OpenAPI 语义门禁契约测试（DFR-M1-A03）。
 *
 * 见 docs/architecture/m1-api-contract.md 第 7 节与 docs/development/m1-taskbook.md。
 *
 * 目的：证明 `pnpm verify` 里的 OpenAPI 门禁**不是**只检查 `$ref` 可解析。
 * 仅靠 spec-consistency.test.ts 的手写断言无法覆盖"语义无效但语法可解析"的类别，
 * 因此这里用行为测试（真实执行 linter）证明：
 *   1. 当前规格通过；
 *   2. 重复 operationId 被拦截；
 *   3. 非法 schema 被拦截。
 *
 * 负对照使用同一份最小基线文档做变异，避免"因为文档本身有别的错误所以失败"的假阳性。
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
 * 通过真实脚本调用门禁，捕获退出码而不是抛异常。
 *
 * 刻意使用**异步** execFile：同步版本会阻塞事件循环，使
 * `describe.concurrent` 下的多个探针退化为串行，拖慢默认测试门禁。
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
 * 最小但语义合法的 OpenAPI 3.1 文档；负对照只在它之上做**单点**变异。
 *
 * `extraPaths` 注入点位于 `paths:` 之下、`components:` 之前，
 * 保证变异落在正确层级——否则会以"结构错误"而非"目标规则"失败，
 * 负对照就失去意义。
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

describe('OpenAPI 语义门禁接线（DFR-M1-A03）', () => {
  it('package.json 暴露 lint:openapi 且 verify 会执行它', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['lint:openapi'], '缺失 lint:openapi 脚本').toBeTruthy();
    expect(pkg.scripts.verify, 'verify 未接入 OpenAPI 语义门禁').toContain('lint:openapi');
  });

  it('门禁工具版本被精确固定（不是范围版本）', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const pinned = pkg.devDependencies['@redocly/cli'];
    expect(pinned, '缺少 @redocly/cli').toBeTruthy();
    // 精确版本：不含 ^ ~ 或区间符号，避免规则集随工具升级漂移。
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe.concurrent('OpenAPI 语义门禁行为（DFR-M1-A03）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'dfr-openapi-lint-'));

  it('当前真实规格通过门禁', async () => {
    const outcome = await runLint('docs/api/openapi.yaml');
    expect(outcome.ok, `规格未通过语义门禁：\n${outcome.output}`).toBe(true);
  }, 60_000);

  it('最小基线文档本身通过（负对照的对照）', async () => {
    const outcome = await runLint(writeProbe(workDir, 'baseline.yaml', baselineSpec));
    expect(outcome.ok, `基线探针文档不合法，负对照不可信：\n${outcome.output}`).toBe(true);
  }, 60_000);

  it('重复 operationId 被拦截', async () => {
    // 单点变异：新增一条与既有 operation 同名 operationId 的路径。
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
    expect(outcome.ok, '重复 operationId 未被拦截').toBe(false);
    expect(outcome.output).toMatch(/operation-operationId-unique|operationId/i);
  }, 60_000);

  it('非法 schema 类型被拦截', async () => {
    const invalid = baselineSpec.replace(
      '        ok: { type: boolean }',
      '        ok: { type: boolean-not-a-type }',
    );
    const outcome = await runLint(writeProbe(workDir, 'invalid-schema.yaml', invalid));
    expect(outcome.ok, '非法 schema 未被拦截').toBe(false);
    expect(outcome.output).toMatch(/type|schema/i);
  }, 60_000);
});
