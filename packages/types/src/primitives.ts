/**
 * DFR base scalar types.
 *
 * Conventions (see docs/architecture/domain-model.md section 4.1):
 * - Amounts, balances, fees, nonces, block heights, slots, and gas always use decimal strings; number is forbidden;
 * - All identifiers use branded types, so ChainId cannot be mixed up with a plain string.
 */

declare const brand: unique symbol;

/** Branded-type constructor: only narrows at the type level, no runtime cost. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Decimal unsigned integer string, regex ^[0-9]+$. */
export type DecimalUint = Brand<string, 'DecimalUint'>;

/** Decimal signed integer string, regex ^-?[0-9]+$. */
export type DecimalInt = Brand<string, 'DecimalInt'>;

/** Chain Registry primary key, lowercase kebab-case, e.g. "ethereum-sepolia". */
export type ChainId = Brand<string, 'ChainId'>;

/**
 * Network environment category.
 *
 * Audit fix A-07/A-08: this type is a **closed set**; brand strings are no longer used.
 * Historically, `network` (brand) and `networkKind` (closed set) coexisted as two fields,
 * but their values were identical across every registry entry — pure redundancy; they are now merged into a single field.
 *
 * Important: the network is uniquely determined by `ChainId` (`ethereum-sepolia` is necessarily testnet).
 * So `network` only exists as a **descriptive attribute** of a chain (Chain / ChainInfo / Provider / AdapterContext),
 * and must not appear on user input or domain objects (AccountRef / AssetRef / TransactionRequest / Transaction /
 * Block / Receipt / ChainEvent / ConfirmRequest); otherwise callers could pass combinations contradicting the chain.
 */
export type NetworkId = 'mainnet' | 'testnet' | 'devnet' | 'custom';

/** Provider logical ID (not a URL). */
export type ProviderId = Brand<string, 'ProviderId'>;

/** Config reference, format "env:VAR_NAME" / "file:/path" / "vault:path". */
export type ConfigRef = Brand<string, 'ConfigRef'>;

/** Endpoint reference; inline plaintext URL credentials are forbidden. */
export type EndpointRef = Brand<string, 'EndpointRef'>;

/** Credential reference; "none" means a public endpoint. */
export type CredentialRef = Brand<string, 'CredentialRef'>;

/** Request ID, format req_<ULID>. */
export type RequestId = Brand<string, 'RequestId'>;

/**
 * DFR internal transaction execution identifier, format txn_<ULID> (see ADR-015 rule 8).
 *
 * It is **a separate fact** from the on-chain txHash: txHash is decided by the signing result, while transactionId is
 * created in the build phase. Write-endpoint response envelopes must keep the two distinguishable, never interchangeable.
 */
export type TransactionId = Brand<string, 'TransactionId'>;

/** ISO 8601 UTC timestamp, e.g. "2026-10-03T10:00:00Z". */
export type Iso8601 = Brand<string, 'Iso8601'>;

/** Opaque pagination cursor; clients must not parse it. */
export type Cursor = Brand<string, 'Cursor'>;

/** Chain family. */
export type ChainFamily = 'evm' | 'solana' | 'bitcoin' | 'tron' | 'cosmos';

/** Provider transport type. */
export type ProviderKind = 'json-rpc-http' | 'json-rpc-ws' | 'grpc' | 'rest';

/** The chain's finality promise level. */
export type Commitment = 'processed' | 'confirmed' | 'finalized';
