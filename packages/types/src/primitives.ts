/**
 * DFR 基础标量类型。
 *
 * 约定（见 docs/architecture/domain-model.md 第 4.1 节）：
 * - 金额、余额、费用、nonce、区块高度、slot、gas 一律使用十进制字符串，禁止 number；
 * - 所有标识使用 branded type，避免 ChainId 与普通 string 混用。
 */

declare const brand: unique symbol;

/** 品牌类型构造器：仅用于类型层面收窄，不产生运行时开销。 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** 十进制无符号整数字符串，正则 ^[0-9]+$。 */
export type DecimalUint = Brand<string, 'DecimalUint'>;

/** 十进制有符号整数字符串，正则 ^-?[0-9]+$。 */
export type DecimalInt = Brand<string, 'DecimalInt'>;

/** Chain Registry 主键，小写短横线，例如 "ethereum-sepolia"。 */
export type ChainId = Brand<string, 'ChainId'>;

/**
 * 网络环境类别。
 *
 * 审计修正 A-07/A-08：本类型是**闭集**，不再使用 brand string。
 * 历史上同时存在 `network`（brand）与 `networkKind`（闭集）两个字段，
 * 而二者的取值在所有注册表条目中完全相同，属于纯冗余；现已合并为单一字段。
 *
 * 重要：网络由 `ChainId` 唯一决定（`ethereum-sepolia` 必然是 testnet）。
 * 因此 `network` 只作为链的**描述属性**存在（Chain / ChainInfo / Provider / AdapterContext），
 * 不得出现在用户输入或领域对象上（AccountRef / AssetRef / TransactionRequest / Transaction /
 * Block / Receipt / ChainEvent / ConfirmRequest），否则调用方可以传入与 chain 矛盾的组合。
 */
export type NetworkId = 'mainnet' | 'testnet' | 'devnet' | 'custom';

/** Provider 逻辑 ID（不是 URL）。 */
export type ProviderId = Brand<string, 'ProviderId'>;

/** 配置引用，格式 "env:VAR_NAME" / "file:/path" / "vault:path"。 */
export type ConfigRef = Brand<string, 'ConfigRef'>;

/** 端点引用，禁止内联明文 URL 凭证。 */
export type EndpointRef = Brand<string, 'EndpointRef'>;

/** 凭证引用；"none" 表示公开端点。 */
export type CredentialRef = Brand<string, 'CredentialRef'>;

/** 请求 ID，格式 req_<ULID>。 */
export type RequestId = Brand<string, 'RequestId'>;

/**
 * DFR 内部交易执行标识，格式 txn_<ULID>（见 ADR-015 第 8 条）。
 *
 * 与链上 txHash 是**两个独立事实**：txHash 由签名结果决定，transactionId 在
 * build 阶段即产生。写端点响应封套必须同时可区分二者，不得互相替代。
 */
export type TransactionId = Brand<string, 'TransactionId'>;

/** ISO 8601 UTC 时间戳，例如 "2026-10-03T10:00:00Z"。 */
export type Iso8601 = Brand<string, 'Iso8601'>;

/** 不透明分页游标，客户端不得解析。 */
export type Cursor = Brand<string, 'Cursor'>;

/** 链族。 */
export type ChainFamily = 'evm' | 'solana' | 'bitcoin' | 'tron' | 'cosmos';

/** Provider 传输类型。 */
export type ProviderKind = 'json-rpc-http' | 'json-rpc-ws' | 'grpc' | 'rest';

/** 链的最终性承诺等级。 */
export type Commitment = 'processed' | 'confirmed' | 'finalized';
