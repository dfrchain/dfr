// E03 前置检查脚本的行为测试。
//
// 为什么值得测：该脚本的失效模式很危险 —— 如果它在**未就绪**时误报 READY，
// 人工就会在缺 RPC / 缺资金账户的情况下继续，把 E03 的证据变成废纸。
// 反之，如果它在**已就绪**时误报 NOT READY，会让人以为环境有问题而反复排查。
//
// 两条路径都锁定：
//   1. 空环境下 → NOT READY + 退出码 1（fail-closed）；
//   2. 前置齐备（含正确 chainId 的 stub RPC）→ READY + 退出码 0；
//   3. 附带一条负对照：chainId 不是 Sepolia → 必须拒绝。
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = './scripts/e03-preflight.sh';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

/** 最小 JSON-RPC stub：对任何请求都回 `eth_chainId` 的结果。 */
async function startRpc(chainId: string): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { id?: unknown };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result: chainId }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface PreflightResult {
  readonly code: number | null;
  readonly stdout: string;
}

/** 用**受控环境**运行脚本：不继承宿主变量，避免测试结果依赖开发机的偶然配置。 */
function runPreflight(env: Record<string, string>): Promise<PreflightResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('bash', [SCRIPT], {
      cwd: repoRoot,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({ code, stdout: stdout + stderr }));
  });
}

describe('E03 前置检查脚本', () => {
  it('空环境 → NOT READY 且退出码 1（缺 RPC / DB / 密钥 / 资金地址）', async () => {
    const result = await runPreflight({});

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('NOT READY');
    // 缺失项要明确指出，而不是笼统失败。
    expect(result.stdout).toContain('DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL');
    expect(result.stdout).toContain('DFR_TRANSACTION_DATABASE_URL');
    expect(result.stdout).toContain('DFR_E03_FUNDED_ADDRESS');
  });

  it('前置齐备（Sepolia chainId）→ READY 且退出码 0', async () => {
    const rpc = await startRpc('0xaa36a7');
    const result = await runPreflight({
      DFR_E03_SKIP_DB: '1',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: rpc,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: rpc,
      DFR_M0_API_KEY_ID: 'TestKey1',
      DFR_M0_API_KEY_HASH: '0'.repeat(64),
      DFR_M1_ALLOW_WRITE: 'true',
      DFR_E03_FUNDED_ADDRESS: '0x1111111111111111111111111111111111111111',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('READY');
    expect(result.stdout).toContain('已声明 transaction.broadcast');
  });

  it('数据库探测能加载 pg 驱动（防"工具问题被误报成数据库不可达"）', async () => {
    // 真实缺陷（2026-10-06 发现）：脚本原先从**仓库根** `require("pg")`，而 `pg` 只装在
    // `packages/storage-postgres/node_modules` 下，于是探测恒以 MODULE_NOT_FOUND 失败，
    // 输出"数据库不可达"——即使数据库完全正常。这正是本文件开头警告的
    // "已就绪却误报 NOT READY"：操作者会去反复排查网络与权限，而真正的问题是脚本自己。
    //
    // 这里不依赖真实数据库：断言脚本**先确认驱动可加载**，再报告连接结果，
    // 两类失败因此可区分（驱动不可用 = 仓库/安装问题；不可达 = 网络/凭证问题）。
    const rpc = await startRpc('0xaa36a7');
    const result = await runPreflight({
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: rpc,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: rpc,
      DFR_M0_API_KEY_ID: 'TestKey1',
      DFR_M0_API_KEY_HASH: '0'.repeat(64),
      DFR_M1_ALLOW_WRITE: 'true',
      DFR_E03_FUNDED_ADDRESS: '0x1111111111111111111111111111111111111111',
      // 指向必然拒绝连接的端口：驱动应能加载，然后如实报告"不可达"。
      DFR_TRANSACTION_DATABASE_URL: 'postgres://dfr_runtime:x@127.0.0.1:1/dfr_m1_test',
    });

    expect(result.stdout).toContain('数据库驱动可用');
    expect(result.stdout).toContain('数据库不可达');
    expect(result.stdout).not.toContain('数据库驱动不可用');
  });

  it('RPC 指向非 Sepolia 链 → 必须拒绝（负对照）', async () => {
    // 0x14a34 = Base Sepolia。指向别的链会让"Sepolia 验收"名不副实。
    const rpc = await startRpc('0x14a34');
    const result = await runPreflight({
      DFR_E03_SKIP_DB: '1',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: rpc,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: rpc,
      DFR_M0_API_KEY_ID: 'TestKey1',
      DFR_M0_API_KEY_HASH: '0'.repeat(64),
      DFR_M1_ALLOW_WRITE: 'true',
      DFR_E03_FUNDED_ADDRESS: '0x1111111111111111111111111111111111111111',
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('不是 Sepolia');
  });

  it('未开启写开关 → 必须拒绝（M1 写路径 fail-closed）', async () => {
    const rpc = await startRpc('0xaa36a7');
    const result = await runPreflight({
      DFR_E03_SKIP_DB: '1',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: rpc,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: rpc,
      DFR_M0_API_KEY_ID: 'TestKey1',
      DFR_M0_API_KEY_HASH: '0'.repeat(64),
      DFR_E03_FUNDED_ADDRESS: '0x1111111111111111111111111111111111111111',
      // DFR_M1_ALLOW_WRITE 故意不设
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('DFR_M1_ALLOW_WRITE');
  });
});
