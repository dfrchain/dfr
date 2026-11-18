/**
 * Quickstart 4/5 — view usage and the effective limits for your key.
 *
 * The numbers are per Gateway process and reset on restart. They are a developer-facing usage
 * view, not an invoice (see docs/api/capability-matrix.md).
 */
import { createClient, heading, show } from './lib.ts';

const dfr = createClient();

heading('GET /v1/usage');
const usage = await dfr.getUsage();
show('usage', {
  projectId: usage.projectId,
  period: usage.period,
  requests: usage.requests,
  lastRequestAt: usage.lastRequestAt,
});
show('limits', usage.limits);
