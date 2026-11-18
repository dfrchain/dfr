/**
 * @dfr/adapter-solana — Solana Adapter (M2 read-only).
 */
export { SolanaAdapter, SOLANA_IMPLEMENTED_CAPABILITIES, type SolanaAdapterOptions } from './adapter.js';
export { assertSolanaAddress, assertSolanaSignature, isSolanaAddress, isSolanaSignature } from './address.js';
export { base58Decode, base58Encode, isBase58 } from './base58.js';
export {
  SolanaCodecError,
  compileMessage,
  decodeMessage,
  decodeTransactionPayload,
  encodeUnsignedTransaction,
  fromBase64,
  hexToBytes,
  splitSignatures,
} from './transaction-codec.js';
export { SolanaBindingError, bindSignedTransaction } from './signed-transaction.js';
export type {
  SolanaBindingErrorReason,
  SolanaSignedBindingInput,
  SolanaSignedBindingResult,
} from './signed-transaction.js';
export type {
  SolanaAccountMeta,
  SolanaCodecErrorReason,
  SolanaCompiledMessage,
  SolanaDecodedInstruction,
  SolanaDecodedTransaction,
  SolanaInstructionIntent,
  SolanaMessageHeader,
  SolanaTransactionVersion,
  SolanaUnsignedIntent,
} from './transaction-codec.js';
