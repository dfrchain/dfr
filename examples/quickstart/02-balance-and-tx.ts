/**
 * Quickstart 2/5 — read an account balance and a transaction status over the same API.
 *
 * This is the core "one API, any chain" promise: only the `chain` field changes.
 *
 * Run:
 *   DFR_API_KEY=... DFR_BASE_URL=... pnpm example:balance
 *
 * Optional:
 *   DFR_EXAMPLE_TX=0x...  also fetch that transaction + receipt
 */
import { ACCOUNT, CHAIN, createClient, heading, show } from './lib.ts';

const dfr = createClient();

heading(`GET /v1/balances (chain=${CHAIN})`);
const balance = await dfr.getBalance({ chain: CHAIN, account: ACCOUNT });
show('balance', balance);

const txHash = process.env['DFR_EXAMPLE_TX'];
if (txHash === undefined || txHash === '') {
  process.stdout.write('\nDFR_EXAMPLE_TX is not set — skipping transaction status.\n');
} else {
  heading(`GET /v1/transactions/${txHash}`);
  show('transaction', await dfr.getTransaction({ chain: CHAIN, txHash }));
  show('receipt', await dfr.getReceipt({ chain: CHAIN, txHash }));
}
