# npm publish — SDK 0.1.0 (2026-11-19)

**Result: published under the `@dfrchain` scope after the initial `@dfr` attempt was blocked.**

| Package | Version | Registry |
|---|---|---|
| `@dfrchain/types` | `0.1.0` | https://www.npmjs.com/package/@dfrchain/types/v/0.1.0 |
| `@dfrchain/sdk-typescript` | `0.1.0` | https://www.npmjs.com/package/@dfrchain/sdk-typescript/v/0.1.0 |

`@dfrchain/sdk-typescript@0.1.0` depends on `@dfrchain/types@^0.1.0`; the published declaration files
use `@dfrchain/types` (staging rewrites the old `@dfr/types` specifier), so `npm i` resolves the
dependency normally.

## Publish evidence

- `npm whoami` = `dfrchain-admin`; `npm org ls dfrchain` = `dfrchain-admin - owner`.
- Initial `@dfr` attempt: `E404 Not Found - PUT https://registry.npmjs.org/@dfr%2ftypes`; no rename
  was attempted at that point.
- `@dfrchain` publish: `PUT ... 202 Accepted` for both packages (npm processes new packages
  asynchronously; registry became readable after a few minutes).
- `npm view @dfrchain/types version` = `0.1.0`; `npm view @dfrchain/sdk-typescript version` = `0.1.0`.

## Tarballs (verified bytes)

| File | sha256 |
|---|---|
| `dfrchain-types-0.1.0.tgz` | `8abf49b754e19ec3512daeabfc43da42f266605b8c89bd6417f4290707dea70f` |
| `dfrchain-sdk-typescript-0.1.0.tgz` | `43da22883bc02a4292d03c2aec2460b182301459386550a6f7a9002eb280f40e` |

## Clean install + real call

```
$ npm i @dfrchain/sdk-typescript      # new empty directory
added 2 packages in 109ms
chains: base-sepolia,ethereum-sepolia
balance: 15415514331002925173368 decimals: 18
logs.page: 1 hasMore: true cursor: true
```

The call used the deployed preview base URL and a project key issued through the preview console;
no key is stored in this repository. `usage()` requires a direct Gateway (the console proxy keeps
per-project usage in the console and does not expose upstream service-wide usage).

## Repository naming (not changed here)

The monorepo still uses the internal `@dfr/*` workspace names. Inventory for the owner's later
decision: **221 files** reference `@dfr/`; the main symbols are `@dfr/types` (190), `@dfr/errors`
(80), `@dfr/transaction` (66), `@dfr/core` (60), `@dfr/adapter-evm` (37), `@dfr/registry` (36).
Package manifests carrying the old name: 16 (adapters/evm, adapters/solana, apps/gateway,
examples/quickstart, packages/*, sdk/typescript, tests).

No CI or release scripts were changed; `~/.npmrc` remains mode `600` and its token was never
printed or committed.
