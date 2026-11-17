/**
 * @dfr/registry —— Chain Registry 加载、校验与投影（DFR-005）。
 *
 * 规范来源：ADR-003、packages/registry/config/README.md
 */
export {
  ChainRegistry,
  projectChain,
  type RawRegistry,
  type RawChain,
  type RawProvider,
  type LoadRegistryOptions,
} from './registry.js';
export {
  CONFIG_DIR,
  DEFAULT_REGISTRY_FILE,
  REGISTRY_SCHEMA_FILE,
  compileSchema,
  loadSchema,
} from './schema.js';
export { scanForSecrets, type SecretFinding } from './secret-scan.js';
export {
  FileVaultReader,
  resolveVaultPath,
  vaultFromEnv,
  type VaultReader,
} from './vault.js';
