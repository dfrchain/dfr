// staging 演练前置检查脚本的行为测试（M5-E01）。
//
// 为什么值得测：这个脚本是"这次 staging 演练能不能开始"的唯一闸门。
// 两种失效模式都会造成损害：
//   1. 未就绪却报 READY → 人在依赖故障的实例上开始演练，证据全废；
//   2. 已就绪却报 NOT READY → 反复排查其实没问题的环境。
// 还有一条**最危险**的：鉴权配漏时脚本若没发现，整场演练的结论都不成立，
// 因此鉴权用**反向**断言锁定（不带 Key 必须 401）。
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = './scripts/staging-preflight.sh';
const FAULT_DRILL_SCRIPT = './scripts/staging-fault-drill.sh';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveRead) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString();
    });
    req.on('end', () => resolveRead(raw));
  });
}

interface StubOptions {
  /** /v1/chains 不带 Key 时返回的状态码；默认 401（鉴权正常）。 */
  readonly unauthChainsStatus?: number;
  /** /metrics 不带 Key 时返回的状态码；默认 401。 */
  readonly unauthMetricsStatus?: number;
  /** /readyz 返回体里的 chains；默认两条都可用。 */
  readonly readyChains?: Array<{ chain: string; providers: number; available: number }>;
  /** /readyz 的 stores 字段；默认 ok。 */
  readonly stores?: string;
  /** /readyz 的状态码；默认 200。 */
  readonly readyStatus?: number;
  /** /v1/chains 带 Key 的 items 数量；默认 2。 */
  readonly chainsCount?: number;
  /** /v1/chains/{id} 的状态码；默认 200。 */
  readonly detailStatus?: number;
  /** /metrics 带 Key 的响应体；默认含两个关键指标族。 */
  readonly metricsBody?: string;
  /** /healthz 状态码；默认 200。 */
  readonly healthStatus?: number;
}

/** 最小 staging 替身：只实现脚本会打的那几个端点。 */
async function startStaging(options: StubOptions = {}): Promise<string> {
  const readyChains = options.readyChains ?? [
    { chain: 'base-sepolia', providers: 1, available: 1 },
    { chain: 'arbitrum-sepolia', providers: 1, available: 1 },
  ];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const hasKey = (req.headers['x-dfr-key'] as string | undefined) !== undefined;
    const send = (status: number, body: string): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    await readBody(req);

    if (url === '/healthz') {
      return send(options.healthStatus ?? 200, JSON.stringify({ status: 'ok', requestId: 'r' }));
    }
    if (url === '/readyz') {
      return send(
        options.readyStatus ?? 200,
        JSON.stringify({
          status: (options.readyStatus ?? 200) === 200 ? 'ready' : 'not_ready',
          requestId: 'r',
          chains: readyChains,
          stores: options.stores ?? 'ok',
        }),
      );
    }
    if (url === '/metrics') {
      if (!hasKey) return send(options.unauthMetricsStatus ?? 401, JSON.stringify({ dfr_code: 'DFR_UNAUTHENTICATED' }));
      return send(
        200,
        options.metricsBody ??
          ['# HELP x', 'dfr_gateway_requests_total{route="listChains"} 1', 'dfr_gateway_inflight_requests{route_class="read"} 0', ''].join('\n'),
      );
    }
    if (url === '/v1/chains') {
      if (!hasKey) return send(options.unauthChainsStatus ?? 401, JSON.stringify({ dfr_code: 'DFR_UNAUTHENTICATED' }));
      const count = options.chainsCount ?? 2;
      return send(
        200,
        JSON.stringify({
          items: Array.from({ length: count }, (_v, i) => ({ id: i === 0 ? 'base-sepolia' : 'arbitrum-sepolia' })),
          requestId: 'r',
        }),
      );
    }
    if (url.startsWith('/v1/chains/')) {
      if (!hasKey) return send(401, JSON.stringify({ dfr_code: 'DFR_UNAUTHENTICATED' }));
      return send(options.detailStatus ?? 200, JSON.stringify({ id: url.slice('/v1/chains/'.length), requestId: 'r' }));
    }
    return send(404, JSON.stringify({ dfr_code: 'DFR_NOT_FOUND' }));
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface Result {
  readonly code: number | null;
  readonly out: string;
}

function run(env: Record<string, string>): Promise<Result> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('bash', [SCRIPT], {
      cwd: repoRoot,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({ code, out }));
  });
}

describe('staging 前置检查脚本', () => {
  it('缺必需输入 → 退出码 2，不假装检查过', async () => {
    const result = await run({});
    expect(result.code).toBe(2);
    expect(result.out).toContain('DFR_STAGING_BASE_URL');
    expect(result.out).toContain('NOT READY');
  });

  it('前置齐备 → READY 且退出码 0', async () => {
    const base = await startStaging();
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
      DFR_STAGING_EXPECT_CHAINS: 'base-sepolia,arbitrum-sepolia',
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('READY');
    expect(result.out).toContain('401');
  });

  it('鉴权配漏（不带 Key 也 200）→ NOT READY（这是必须拦下的）', async () => {
    const base = await startStaging({ unauthChainsStatus: 200, unauthMetricsStatus: 200 });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('NOT READY');
    expect(result.out).toContain('鉴权');
  });

  it('依赖未就绪（/readyz 503 且 stores 不可用）→ NOT READY', async () => {
    const base = await startStaging({ readyStatus: 503, stores: 'unavailable' });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('NOT READY');
    expect(result.out).toContain('503');
  });

  it('某条链没有可用 Provider → NOT READY 并点名该链', async () => {
    const base = await startStaging({
      readyChains: [
        { chain: 'base-sepolia', providers: 1, available: 1 },
        { chain: 'arbitrum-sepolia', providers: 1, available: 0 },
      ],
    });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('arbitrum-sepolia');
  });

  it('期望链缺失 → NOT READY', async () => {
    const base = await startStaging();
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
      DFR_STAGING_EXPECT_CHAINS: 'base-sepolia,solana-devnet',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('solana-devnet');
  });

  it('期望链详情不可读 → NOT READY 并点名链', async () => {
    const base = await startStaging({ detailStatus: 404 });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
      DFR_STAGING_EXPECT_CHAINS: 'base-sepolia,arbitrum-sepolia',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('base-sepolia');
    expect(result.out).toContain('详情');
  });

  it('链清单为空 → NOT READY（演练无从下手）', async () => {
    const base = await startStaging({ chainsCount: 0 });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('空');
  });

  it('关键指标族缺失 → NOT READY（演练期间看不清状态）', async () => {
    const base = await startStaging({ metricsBody: '# HELP x\ndfr_other_metric 1\n' });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('dfr_gateway_requests_total');
  });

  it('从不打印 API Key 值', async () => {
    const base = await startStaging();
    const secret = 'supersecretvalue0123456789';
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: `dfr_StageK01_${secret}`,
    });
    expect(result.out).not.toContain(secret);
  });
});

describe('staging 前置检查：语义边界（防"误报 NOT READY"）', () => {
  it('链未配置端点（providers=0）不是故障，README 口径下应 READY', async () => {
    // 真实缺陷（2026-10-08 实测发现）：脚本原先把 `available == 0` 一律当"链不可用"，
    // 而部署里 **未配置端点的链**（如 solana-devnet 在只启用 EVM 的实例上）
    // 恰好也是 available=0。于是正常部署被判 NOT READY，操作者会去排查
    // 一个根本不存在的问题——正是本文件开头警告的第二种失效模式。
    // 语义应为：providers>0 且 available==0 才是"配了但全挂"。
    const base = await startStaging({
      readyChains: [
        { chain: 'base-sepolia', providers: 1, available: 1 },
        { chain: 'solana-devnet', providers: 0, available: 0 },
      ],
    });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('未配置端点的链');
  });

  it('指标族名与实现一致（dfr_gateway_inflight_requests，不是 dfr_gateway_inflight）', async () => {
    // 真实缺陷（2026-10-08 实测发现）：脚本检查的是 `dfr_gateway_inflight`，
    // 而 Gateway 实际导出的是 `dfr_gateway_inflight_requests`。名字写错会让
    // 正常实例被判"指标缺族"。
    const base = await startStaging({
      metricsBody: [
        '# HELP x',
        'dfr_gateway_requests_total{route="listChains"} 1',
        'dfr_gateway_inflight_requests{route_class="read"} 0',
        '',
      ].join('\n'),
    });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code, result.out).toBe(0);
  });
});

describe('staging 前置检查：大响应体（防 SIGPIPE 假失败）', () => {
  it('指标体很大时仍能正确判定关键族齐备（不因 grep -q 提前退出而假失败）', async () => {
    // 真实缺陷（2026-10-08 对真实实例实测发现）：
    // 脚本原先用 `printf '%s' "${metrics}" | grep -q "^family"`。指标体可达数十 KB，
    // `grep -q` 命中第一条即退出 → printf 收到 SIGPIPE → 在 `set -o pipefail` 下
    // 整条管道返回非零 → **关键指标明明存在却被判缺失**。
    // 实测实例的 /metrics 有 75KB，正是这个假失败把 READY 变成 NOT READY。
    // 修法是先落临时文件再 grep（无管道、无 SIGPIPE）。
    const pad = Array.from({ length: 4000 }, (_v, i) => `dfr_filler_metric_${i}{chain="x"} ${i}`).join('\n');
    const base = await startStaging({
      metricsBody: `# HELP x\ndfr_gateway_requests_total{route="listChains"} 1\n${pad}\ndfr_gateway_inflight_requests{route_class="read"} 0\n`,
    });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('关键指标族齐备');
  });
});

describe('staging 前置检查：凭证进程可见性', () => {
  it('不会把 API Key 展开为 curl 命令行参数，并会清理受限 Header 临时文件', () => {
    // API Key 进环境变量是 runbook 的受控输入；但若再展开到 `curl -H "...${KEY}"`
    // 的 argv，同机可查看进程参数的主体会在请求期间看到它。Header 必须经 0600
    // 临时文件传给 curl，且脚本退出时删除该文件。
    const source = readFileSync(resolve(repoRoot, SCRIPT), 'utf8');
    expect(source).not.toContain('-H "X-DFR-Key: ${KEY}"');
    expect(source).toContain('AUTH_HEADER_FILE');
    expect(source).toContain('chmod 600 "${AUTH_HEADER_FILE}"');
    expect(source).toContain('rm -f "${AUTH_HEADER_FILE}"');
    expect(source).toContain('-H "@${AUTH_HEADER_FILE}"');
  });

  it('隔离故障演练也不会把临时 API Key 展开为 curl 命令行参数', () => {
    const source = readFileSync(resolve(repoRoot, FAULT_DRILL_SCRIPT), 'utf8');
    expect(source).not.toContain('-H "X-DFR-Key: ${API_KEY}"');
    expect(source).toContain('API_KEY_HEADER_FILE');
    expect(source).toContain('chmod 600 "${API_KEY_HEADER_FILE}"');
    expect(source).toContain('rm -f "${API_KEY_HEADER_FILE}"');
    expect(source).toContain('-H "@${API_KEY_HEADER_FILE}"');
  });
});
