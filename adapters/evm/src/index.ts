/**
 * @dfr/adapter-evm — EVM Adapter (DFR-008, M0 read-only).
 */
export {
  EvmAdapter,
  EVM_IMPLEMENTED_CAPABILITIES,
  EVM_M0_CAPABILITIES,
  type EvmAdapterOptions,
} from './adapter.js';
export { isEvmAddress, isEvmTxHash, assertEvmAddress, assertEvmTxHash } from './address.js';
export { hexToDecimalUint, decimalUintToHex, hexToSafeNumber } from './hex.js';
export {
  bindSignedTransaction,
  parseSignedTransaction,
  type EvmSignedBindingExpectation,
  type EvmSignedTransactionBinding,
} from './signed-transaction.js';
export {
  EvmCodecError,
  assertDecodedMatchesIntent,
  decodeTransactionPayload,
  encodeUnsignedTransaction,
  type EvmAccessListEntry,
  type EvmCodecErrorReason,
  type EvmDecodedTransaction,
  type EvmTransactionType,
  type EvmUnsignedIntent,
  type EvmUnsignedPayload,
} from './transaction-codec.js';
