// Register the DFR runtime resolution hooks (M1-E02).
//
// Usage:
//   node --experimental-strip-types --experimental-transform-types \
//     --import ./scripts/ts-runtime/register.mjs apps/gateway/src/main.ts
//
// Why `--experimental-transform-types` is needed: the repository uses TS
// parameter properties (`constructor(private readonly pool: Pool) {}`),
// which strip mode does not support — transformation is required.
import { register } from 'node:module';
register('./resolve-hooks.mjs', import.meta.url);
