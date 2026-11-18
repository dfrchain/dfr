/**
 * Quickstart 1/5 — discover what this deployment actually serves.
 *
 * Run:
 *   DFR_API_KEY=... DFR_BASE_URL=... pnpm example:chains
 *
 * Expected: the chain list, then runtime info for the first chain. If the list is empty, the
 * deployment has no chain enabled — fix the registry before debugging your client.
 */
import { CHAIN, createClient, heading, show } from './lib.ts';

const dfr = createClient();

heading('GET /v1/chains');
const chains = await dfr.listChains();
show('chains', chains.map((chain) => ({ id: chain.id, family: chain.family, capabilities: chain.capabilities })));

if (chains.length === 0) {
  process.stdout.write('No chain is enabled on this deployment.\n');
  process.exit(0);
}
const target = chains.some((chain) => chain.id === CHAIN) ? CHAIN : (chains[0]?.id ?? CHAIN);

heading(`GET /v1/chains/${target}`);
show('chainInfo', await dfr.getChain(target));
