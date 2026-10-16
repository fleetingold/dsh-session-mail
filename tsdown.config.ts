/**
 * tsdown config for the client half of dsh-session-mail. Self-contained (the
 * shared packages/client preset requires the package to live inside the
 * repository packages tree, and this out-of-tree package cannot import the
 * tsdown package): a plain config object — `defineConfig` is only a typed
 * identity — producing the closure-factory CJS artifact whose banner hands
 * the module to the shell's module loader, with React external (a
 * PLATFORM_MODULES baseline row the loader's require resolves). All other
 * imports are package-local; workspace type imports are erased at build.
 * @module build
 */
export default {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  // Never-bundle the react package prefix: 'react' plus the automatic JSX
  // runtime's 'react/jsx-runtime', both module-table rows.
  deps: { neverBundle: [/^react(?:\/|$)/] },
  define: { 'process.env.NODE_ENV': '"production"' },
  outputOptions: {
    entryFileNames: 'client.js',
    // The closure-factory wrapper MUST live in outputOptions (rolldown output
    // options, mirroring packages/client/tsdown.client.ts): top-level intro
    // is silently dropped by tsdown, and a missing `var exports` definition
    // crashes the browser load with "exports is not defined".
    banner: "window.__ModuleLoader__.load({ id: 'dsh-session-mail', factory: (require) => {",
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
