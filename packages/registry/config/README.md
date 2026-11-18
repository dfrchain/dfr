# Chain Registry Configuration

Normative sources: [ADR-003](../../../docs/adr/ADR-003-chain-registry.md), [provider-spec-v0.1.md](../../../docs/architecture/provider-spec-v0.1.md).

## Files

| File | Purpose |
|---|---|
| `chains.yaml` | Chain and Provider inventory (the single source of configuration facts) |
| `chains.schema.json` | JSON Schema 2020-12; startup validation and CI validation **share this same file** |
| `README.md` | This guide (environment variable names, validation rules) |

## Security constraints

1. `chains.yaml` must **never** contain any private key, mnemonic, API key, or token in plaintext.
2. Only reference forms are allowed: `env:VAR`, `file:/path`, `vault:path`.
3. Public endpoints must use `credentialRef: "none"`.
4. Resolved credentials live only in memory; they must never be written to logs, metrics, or error details.
5. `.env` files must have mode `600` and must be ignored by `.gitignore`.

### `vault:` references (M5 production hardening E4)

`vault:` means "resolved by a secret manager", as distinct from `env:` (process environment) and `file:` (local file).
The default implementation is a **file-based vault**: `DFR_VAULT_DIR` points at the root directory, and the part after `vault:` is a path relative to that root.

```text
DFR_VAULT_DIR=/run/secrets/dfr

# In chains.yaml:
credentialRef: "vault:providers/base-sepolia.key"
# Actually reads /run/secrets/dfr/providers/base-sepolia.key
```

Behavior:

- When **`DFR_VAULT_DIR` is not set** and no `VaultReader` is injected, resolving a `vault:` reference **throws a configuration error**
  (fail-closed) — it must never silently degrade to "unauthenticated", or an endpoint that needs a key would become anonymous;
- **Path escapes are rejected** (`..`, absolute paths); out-of-bounds and "entry does not exist" are **indistinguishable** in logs;
- To use a real Vault / KMS, inject a custom `VaultReader`; the registry format stays **unchanged**.

## Required environment variables (names only, no values)

Provider endpoints (M0 needs at least the first two to reach Sepolia):

```text
DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL
DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_KEY      # Not needed for public endpoints
DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL
DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_KEY    # Not needed for public endpoints
DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL
DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL
```

Registry and Gateway:

```text
DFR_REGISTRY_FILE                 # Optional; points at a local override config; defaults to chains.yaml in this directory
DFR_GATEWAY_PORT                  # Optional; default 8787
DFR_M0_API_KEY_ID                 # Required; 8-char base62, not a secret, may appear in audit logs
DFR_M0_API_KEY_HASH               # Required; hex of sha256(secret+pepper)
DFR_M0_API_KEY_ID_PREVIOUS        # Optional; previous keyId during rotation
DFR_M0_API_KEY_HASH_PREVIOUS      # Optional; previous hash during rotation
DFR_M0_API_KEY_PEPPER             # Optional; hash pepper, strongly recommended
DFR_M0_PROJECT_ID                 # Optional; default default
DFR_RUN_TESTNET                   # Optional; real testnet integration runs only when =1
DFR_TESTNET_TX_HASH               # Optional; used to verify real transaction queries
```

### Endpoint resolution semantics (M0)

- A **missing** environment variable referenced by `endpointRef` is a configuration error: constructing the Provider throws `DFR_CONFIGURATION_ERROR`,
  and no request is sent to an undefined address.
- A missing environment variable referenced by `credentialRef` is treated as **unauthenticated access to a public endpoint** (returns undefined).
  Use a `file:` reference when credentials must be enforced.
- `vault:` is not implemented in M0; encountering one throws a configuration error.

> This phase provides no `.env.example` (DFR-001 decision). An environment-variable template easily becomes a place where someone "just fills in a real key";
> when configuration is needed, create a local `.env` directly and set `chmod 600`.

## Validation rules

**Structural rules are defined by `chains.schema.json`** and are not repeated here (to avoid rule drift; review fix R-13).
The startup validator (DFR-005) and CI must evaluate the same schema.

Beyond the schema, the following **cross-field reference integrity** must also be validated (JSON Schema cannot express it):

1. Every `providers[].chain` must be found in `chains`.
2. Every `chains[].adapter.id` must have a corresponding registered Adapter.
3. Every `chains[].capabilities[]` must be a subset of the capabilities actually declared by that Adapter (`registry ⊆ adapter`, see review fix R-03); a violation → `DFR_CONFIGURATION_ERROR`, fail-closed.
4. A pattern resembling a secret (`0x` + 64 hex chars, `sk-`, `AKIA` prefix) → refuse to load and raise an alert.

## Source-of-truth rules (review fix R-03)

```text
Registry.capabilities   = allowlist (which capabilities we expose)
Adapter.capabilities()  = capability truth (what this chain can actually do)
```

At startup, validate `registry ⊆ adapter`; at runtime, **Adapter** wins. A mismatch is a configuration error: refuse to start rather than degrade.

## Verification status of finality facts (review fix R-22)

Each chain carries a `finalityStatus`:

- `unverified`: the finality parameters are initial assumptions, **not yet verified against a real RPC**;
- `verified`: verified with real data in DFR-014, with evidence recorded in `docs/reviews/`.

`ethereum-sepolia` has been verified by DFR-014 against two independent RPCs and marked `verified`
(evidence: `docs/reviews/2026-10-03-dfr-014-testnet-evidence.md`);
`base-sepolia` and `solana-devnet` are still `unverified`.
In particular, `base-sepolia`'s `confirmations: 12` currently has no basis — L2 finality depends on its data availability on L1,
and cannot be settled by picking a confirmation count; DFR-014 must produce an evidence-backed FinalityPolicy.

## Capability enablement status

`capabilities` must lag behind implementation and **must never declare a capability the Adapter has not implemented yet** (otherwise M1 fails at startup with
`DFR_CONFIGURATION_ERROR`). Currently:

- `ethereum-sepolia` (M1): `account.balance` / `block.read` / `transaction.read` +
  `transaction.build` / `transaction.simulate` (enabled by DFR-M1-B10);
- `base-sepolia` (M1): same as above, except `transaction.broadcast` was removed in DFR-M1-B10 —
  the EVM Adapter does not implement broadcast yet; it will be added back after DFR-M1-C02;
- `solana-devnet` (M2): read-only + `event.subscribe`; the M2 task book replans this.
