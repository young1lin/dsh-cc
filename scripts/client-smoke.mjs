/**
 * Client-bundle smoke test: execute lib/client.js against a stubbed module
 * loader and real react, then drive apply() to the slot registration.
 * Run: node scripts/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(join(packageDir, 'package.json'))

let loaded
globalThis.window = { __ModuleLoader__: { load(options) { loaded = options } } }

const requireStub = (name) => {
  if (name === 'react-dom') return { createPortal: () => { throw new Error('createPortal must not run in the smoke test') } }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    // The published artifact is a browser closure bundle; stub the one value
    // this plugin imports.
    return { MarkdownText: () => null }
  }
  return nodeRequire(name)
}

// eslint-disable-next-line no-eval -- the artifact is a closure bundle, not a module
eval(readFileSync(join(packageDir, 'lib', 'client.js'), 'utf8'))

if (!loaded || loaded.id !== 'dsh-cc') {
  console.error('FAIL: loader handoff missing')
  process.exit(1)
}
const plugin = loaded.factory(requireStub)
console.log('factory exports inject:', JSON.stringify(plugin.inject))
console.log('factory exports apply:', typeof plugin.apply)

const registrations = []
const fakeCtx = {
  slots: {
    inject(slotName, factory) {
      registrations.push(['inject', slotName])
      const disposer = factory()
      registrations.push(['registered', disposer === undefined ? 'void' : typeof disposer])
    },
    register(options, component) {
      registrations.push(['register', options.name, options.id, typeof component])
      return () => {}
    },
  },
  effect: () => {},
}
plugin.apply(fakeCtx)
console.log('registrations:', JSON.stringify(registrations))
const expected = JSON.stringify([
  ['inject', 'sidebar.footer.action'],
  ['register', 'sidebar.footer.action', 'claude-code', 'function'],
  ['registered', 'function'],
])
if (JSON.stringify(registrations) !== expected) {
  console.error('FAIL: unexpected registration sequence')
  process.exit(1)
}
console.log('CLIENT BUNDLE OK')
