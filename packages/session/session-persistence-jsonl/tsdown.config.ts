import { defineConfig } from 'tsdown'
import { decoratorPlugin } from '../../typert/generator/lib/types/tsdown-plugin.js'

/** Build the backend and its path-loaded workers as separate bundles. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : [
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/worker.js'],
    // Fresh verifiers need no host singleton identity. Inline their JavaScript
    // closure to avoid resolving and compiling workspace packages on every open.
    deps: { alwaysBundle: [/^@deepseek-ai\/(?!node-addon-system)/] },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/read-worker.js'],
    // The read worker boots this backend's own provider in one long-lived
    // Worker Thread, so its closure (including Cordis and p-limit, whose CJS
    // interop differs from their ESM default exports) is inlined as one bundle.
    // Only the native system addon stays external, as for the verifier.
    deps: { alwaysBundle: [/^@deepseek-ai\/(?!node-addon-system)/, /^p-limit$/, /^yocto-queue$/] },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // Cordis services use standard decorators that Node cannot execute directly.
    plugins: [decoratorPlugin()],
  },
])
