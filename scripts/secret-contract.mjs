/**
 * Contract smoke for device-bound provider-secret storage.
 * Run with: node scripts/secret-contract.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openEnvForSpawn,
  redactEnvForWire,
  retainWireSecrets,
  sealEnvForStorage,
} from '../src/secret-box.ts'
import { loadSettings } from '../src/settings-file.ts'
import { SessionStore } from '../src/store.ts'
import { SECRET_VALUE_SET } from '../src/types.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-cc-secret-contract-'))
const secret = 'contract-token-plaintext-never-on-disk'

try {
  const sealed = sealEnvForStorage(root, {
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_BASE_URL: 'https://example.test',
  })
  assert.match(sealed.ANTHROPIC_AUTH_TOKEN, /^dshcc1\./)
  assert.ok(!sealed.ANTHROPIC_AUTH_TOKEN.includes(secret))
  assert.deepEqual(openEnvForSpawn(root, sealed), {
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_BASE_URL: 'https://example.test',
  })
  assert.equal(redactEnvForWire(sealed).ANTHROPIC_AUTH_TOKEN, SECRET_VALUE_SET)
  assert.equal(
    retainWireSecrets({ ANTHROPIC_AUTH_TOKEN: SECRET_VALUE_SET }, sealed).ANTHROPIC_AUTH_TOKEN,
    sealed.ANTHROPIC_AUTH_TOKEN,
  )

  const envelope = sealed.ANTHROPIC_AUTH_TOKEN
  const tamperAt = envelope.length - 10
  const replacement = envelope[tamperAt] === 'A' ? 'B' : 'A'
  const tampered = {
    ...sealed,
    ANTHROPIC_AUTH_TOKEN: envelope.slice(0, tamperAt) + replacement + envelope.slice(tamperAt + 1),
  }
  assert.throws(() => openEnvForSpawn(root, tampered), /无法在这台设备上解密/)

  const settingsDir = join(root, 'settings')
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
    model: '',
    permissionMode: '',
    env: { ANTHROPIC_AUTH_TOKEN: secret },
    presets: [],
    activePresetId: '',
    accounts: [],
    activeAccountId: '',
  }), 'utf8')
  const settings = loadSettings(settingsDir)
  assert.match(settings.env.ANTHROPIC_AUTH_TOKEN, /^dshcc1\./)
  assert.equal(openEnvForSpawn(settingsDir, settings.env).ANTHROPIC_AUTH_TOKEN, secret)
  assert.ok(!readFileSync(join(settingsDir, 'settings.json'), 'utf8').includes(secret))

  const storeDir = join(root, 'store')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(join(storeDir, 'index.json'), JSON.stringify([{
    id: 'legacy-row',
    name: 'legacy',
    cwd: root,
    model: '',
    status: 'idle',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messageCount: 0,
    env: { ANTHROPIC_AUTH_TOKEN: secret },
    accountEnv: { ANTHROPIC_API_KEY: secret },
  }]), 'utf8')
  const store = new SessionStore(storeDir)
  store.load()
  assert.match(store.get('legacy-row').env.ANTHROPIC_AUTH_TOKEN, /^dshcc1\./)
  const indexText = readFileSync(join(storeDir, 'index.json'), 'utf8')
  assert.ok(!indexText.includes(secret))
  assert.match(indexText, /dshcc1\./)

  console.log('secret contract: ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
