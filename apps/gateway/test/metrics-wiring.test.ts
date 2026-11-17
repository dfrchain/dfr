//
// 生产 composition root 的指标装配测试（DFR-M1-D06）。
//
// 之前 `startGateway` 只把 `metrics` 留在 `GatewayOptions` 里，没有任何调用方装配它，
// 因此真实部署访问 `GET /metrics` 会得到"指标端点未启用"。本测试用真实
// `startGateway`（不是手搓 server）断言：M0 部署也必须暴露一个受鉴权保护的指标端点。
//
import { describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../src/index.js';
import { startGateway } from '../src/main.js';

const KEY_ID = 'MetricsA';
const SECRET = 'metricsWiringSecret0123456789abcdef';
const PEPPER = 'metrics-wiring-pepper';

describe('startGateway 指标装配（DFR-M1-D06）', () => {
  it('M0 部署暴露受鉴权保护的 GET /metrics，而不是"指标端点未启用"', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const app = await startGateway({
      DFR_M0_API_KEY_ID: KEY_ID,
      DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
      DFR_M0_API_KEY_PEPPER: PEPPER,
      DFR_GATEWAY_PORT: '0',
    });
    try {
      expect(typeof app.port).toBe('number');
      const url = `http://127.0.0.1:${app.port}/metrics`;

      const unauth = await fetch(url);
      expect(unauth.status).toBe(401);

      const ok = await fetch(url, { headers: { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/plain');
      expect(await ok.text()).not.toContain('未启用');
    } finally {
      await app.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
