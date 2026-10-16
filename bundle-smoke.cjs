/**
 * Artifact-plane smoke: execute a served /plugins bundle exactly as the shell
 * module loader does — capture the factory, call it with a require that
 * resolves the platform rows, and assert the module exports apply/inject.
 * Usage: node bundle-smoke.cjs <path-to-client.js> [module-base-package.json]
 */
const fs = require('node:fs')
const Module = require('node:module')

const bundlePath = process.argv[2]
// The module base is a parameter, not a default: the bundle is executed with a
// `require` that must resolve the platform rows (react and its JSX runtime), and
// only the caller knows where those live. A hardcoded path here would both be
// wrong on any other machine and leak one machine's layout, so the third argument
// is required and the error says what to pass.
if (bundlePath === undefined || process.argv[3] === undefined) {
  console.error('usage: node bundle-smoke.cjs <path-to-client.js> <module-base-package.json>')
  console.error('  e.g. node bundle-smoke.cjs lib/client.js "$(node -p "require.resolve(\'react/package.json\')")"')
  process.exit(2)
}
const moduleBase = process.argv[3]
const repoRequire = Module.createRequire(moduleBase)
const code = fs.readFileSync(bundlePath, 'utf8')

let captured
globalThis.window = { __ModuleLoader__: { load(entry) { captured = entry } } }

try {
  ;(0, eval)(code)
} catch (error) {
  console.error('FAIL: bundle threw while loading:', error.message)
  process.exit(1)
}
if (captured === undefined) {
  console.error('FAIL: window.__ModuleLoader__.load was never called')
  process.exit(1)
}

let mod
try {
  mod = captured.factory(repoRequire)
} catch (error) {
  console.error('FAIL: factory threw:', error.message)
  process.exit(1)
}

console.log('id:', captured.id)
console.log('exports keys:', Object.keys(mod).join(', '))
console.log('apply:', typeof mod.apply, '| inject:', Array.isArray(mod.inject) ? `array(${mod.inject.length})` : typeof mod.inject)
const ok = typeof mod.apply === 'function' && Array.isArray(mod.inject)
console.log(ok ? 'PASS: bundle materializes and exports apply/inject' : 'FAIL: exports lack apply/inject')
process.exit(ok ? 0 : 1)
