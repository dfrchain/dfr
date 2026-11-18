// DFR runtime module-resolution hooks (M1-E02).
//
// Background: this repository is an ESM TypeScript source repo with
// `module: NodeNext`, so imports always use `.js` specifiers (`./server.js`)
// while the files on disk are `.ts`. Node's built-in type stripping
// (`--experimental-strip-types` / `--experimental-transform-types`) does
// **not** remap a `.js` specifier to `.ts`, so
// `node --experimental-strip-types apps/gateway/src/main.ts` fails with
// `ERR_MODULE_NOT_FOUND: .../server.js`.
//
// This hook does exactly one thing: when normal `.js` resolution fails, try
// the same name with `.ts`. It keeps zero runtime dependencies (no tsx /
// ts-node / esbuild), matching the repository's stance that "one fewer
// dependency is one less supply-chain risk". The behavior has a real
// process-level regression test in tests/contract/ts-runtime.test.ts.

/**
 * @param {string} specifier
 * @param {unknown} context
 * @param {(s: string, c: unknown) => Promise<unknown>} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // Fall back only for `.js` → `.ts`; other specifiers (package names,
    // node:, data:) are rethrown as-is, so a genuine "module does not exist"
    // error is not masked as a different path.
    if (specifier.endsWith('.js')) {
      try {
        return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // Fall back to the original error: at this point `.ts` does not
        // exist either, so the original diagnostic is more useful.
      }
    }
    throw error;
  }
}
