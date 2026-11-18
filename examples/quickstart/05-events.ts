/**
 * Quickstart 5/5 — subscribe to chain events (SSE), for both server and browser clients.
 *
 * Server/client path: `X-DFR-Key` header.
 * Browser path: `EventSource` cannot set headers, so issue a one-time ticket first and pass it
 * as `?ticket=`; the ticket is bound to the key, client IP and filter.
 *
 * Run:
 *   DFR_API_KEY=... DFR_BASE_URL=... pnpm example:events
 *
 * Waiting time: DFR_EXAMPLE_WAIT_MS (default 5000). A quiet chain with no events is a success:
 * the example proves that the stream was established and authenticated.
 */
import { CHAIN, createClient, firstEvent, heading } from './lib.ts';

const dfr = createClient();
const waitMs = Number(process.env['DFR_EXAMPLE_WAIT_MS'] ?? '5000');

heading('SSE with the X-DFR-Key header');
const headerStream = dfr.subscribeEvents({ chain: CHAIN as never });
const headerEvent = await firstEvent(headerStream.events, waitMs, () => headerStream.close());
if (headerEvent === undefined) {
  process.stdout.write(`Stream established; no events within ${waitMs}ms.\n`);
} else {
  process.stdout.write(`Received ${headerEvent.type} (cursor=${headerEvent.cursor})\n`);
}

heading('SSE with a one-time ticket (browser EventSource path)');
const ticket = await dfr.createEventTicket({ filter: { chain: CHAIN as never }, ttlMs: 30_000 });
const ticketStream = dfr.subscribeEventsWithTicket(ticket.ticket, { chain: CHAIN as never });
const ticketEvent = await firstEvent(ticketStream.events, waitMs, () => ticketStream.close());
if (ticketEvent === undefined) {
  process.stdout.write(`Ticket stream established; no events within ${waitMs}ms.\n`);
} else {
  process.stdout.write(`Received ${ticketEvent.type} (cursor=${ticketEvent.cursor})\n`);
}
