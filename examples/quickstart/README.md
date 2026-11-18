# DFR Quickstart Examples

Runnable examples for the DFR API and TypeScript SDK. Each file is standalone and imports the
workspace SDK (`@dfr/sdk-typescript`) through this package's workspace dependency.

## Prerequisites

- Node.js >= 22 (the repo's `engines` requirement).
- A reachable DFR Gateway and an API key (see `docs/api/quickstart.md`).
- For `05-events.ts`: SSE enabled on the deployment.

## Run

```bash
export DFR_BASE_URL='http://127.0.0.1:8787'
export DFR_API_KEY='dfr_<keyId>_<secret>'
# optional
export DFR_EXAMPLE_CHAIN='ethereum-sepolia'
export DFR_EXAMPLE_ACCOUNT='0x1111...'
export DFR_EXAMPLE_TX='0x...'
export DFR_EXAMPLE_WAIT_MS='5000'

pnpm examples:quickstart   # all five, in order
# or one at a time
pnpm example:chains
pnpm example:balance
pnpm example:errors
pnpm example:usage
pnpm example:events
```

## What each example proves

| File | Proves |
|---|---|
| `01-chains.ts` | Discovery: `/v1/chains` + `/v1/chains/{id}`; what the deployment serves |
| `02-balance-and-tx.ts` | The same API reads balance and transaction status by changing `chain` |
| `03-errors.ts` | Errors are data: stable `dfr_code`, `requestId`, `safeToRetry`, retry behavior |
| `04-usage.ts` | `GET /v1/usage` counts and effective limits |
| `05-events.ts` | SSE with header auth and with a one-time browser ticket |

## Offline verification

`tests/e2e/developer-quickstart.e2e.test.ts` boots a real Gateway + Core + EVM Adapter against a
stand-in provider and executes all five examples as child processes, asserting output, no retry of
unsafe operations, and that no credential is ever printed. That is the regression guard for these
files — run `pnpm vitest run tests/e2e/developer-quickstart.e2e.test.ts`.
