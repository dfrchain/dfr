//
// Production composition-root metrics assembly test (DFR-M1-D06).
//
// Previously `startGateway` only left `metrics` in `GatewayOptions`, with no caller assembling it,
// so a real deployment visiting `GET /metrics` would get "Metrics endpoint is not enabled". This test uses a real
// `startGateway` (not a hand-built server) to assert: an M0 deployment must also expose an authenticated metrics endpoint.
//
import { describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../src/index.js';
import { startGateway } from '../src/main.js';

const KEY_ID = 'MetricsA';
const SECRET = 'metricsWiringSecret0123456789abcdef';
const PEPPER = 'metrics-wiring-pepper';

describe('startGateway metrics assembly (DFR-M1-D06)', () => {
  it('M0 deployments expose an authenticated GET /metrics, not "Metrics endpoint is not enabled"', async () => {
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
      expect(await ok.text()).not.toContain('Metrics endpoint is not enabled');
    } finally {
      await app.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
