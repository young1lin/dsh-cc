/**
 * dsh-cc build: the Node-half ESM library plus the browser client bundle.
 *
 * The client artifact replicates the dsh dynamic-package closure format: a
 * CJS factory handed to window.__ModuleLoader__.load, with the shell-seeded
 * platform modules (react, react/jsx-runtime, react-dom) left external so the
 * module table supplies the shared instances. Everything else inlines.
 */
import { defineConfig } from 'tsdown'

const platformExternals = [/^react($|\/)/, /^react-dom($|\/)/, /^@deepseek-ai\//, /^@anthropic-ai\//, /^node:/]

/** Module-table baseline the shell seeds: react family plus ui-primitives. */
const browserExternals = [/^react($|\/)/, /^react-dom($|\/)/, /^@deepseek-ai\/dsh-client-ui-primitives($|\/)/]

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: false,
    dts: false,
    clean: false,
    external: platformExternals,
    outputOptions: {
      entryFileNames: 'index.js',
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    dts: false,
    clean: false,
    external: browserExternals,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-cc", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
