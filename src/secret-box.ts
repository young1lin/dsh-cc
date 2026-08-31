/**
 * Device-bound protection for provider credentials persisted by dsh-cc.
 *
 * Windows wraps a random AES-256 device key with DPAPI CurrentUser. macOS and
 * Linux keep the corresponding key in Keychain / Secret Service; headless Linux falls
 * back to a random local seed combined with /etc/machine-id. Plaintext exists
 * only while an incoming value is sealed or an engine builds its spawn env.
 *
 * @module dsh-cc/secret-box
 */

import { spawnSync } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { userInfo } from 'node:os'
import {
  SECRET_VALUE_LOCKED,
  SECRET_VALUE_SET,
  isProtectedEnvKey,
  isSecretEnvKey,
} from './types.ts'

const ENVELOPE_PREFIX = 'dshcc1.'
const KEY_BYTES = 32
const AES_AAD_VERSION = 'dsh-cc/provider-secret/v1'
const KEYCHAIN_SERVICE = 'dsh-cc device secrets'
const keyCache = new Map<string, { backend: string; key: Buffer }>()

const POWERSHELL_PROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$raw=[Console]::In.ReadToEnd()',
  '$bytes=[Convert]::FromBase64String($raw)',
  '$cipher=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($cipher))',
].join(';')

const POWERSHELL_UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$raw=[Console]::In.ReadToEnd()',
  '$bytes=[Convert]::FromBase64String($raw)',
  '$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join(';')

/** A credential could not be protected or opened on this device. */
export class SecretBoxError extends Error {
  /**
   * @param message - user-facing failure description.
   * @param cause - platform command or crypto failure.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SecretBoxError'
  }
}

/**
 * Whether a value is a dsh-cc encrypted envelope rather than plaintext.
 * @param value - environment value.
 * @returns true for any supported dsh-cc v1 envelope.
 */
export function isSealedSecret(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX)
}

/**
 * Seal the two Anthropic credential variables in an environment map.
 * @param dataDir - plugin data directory, used to scope native key entries.
 * @param env - source map; never mutated.
 * @returns a copied map whose provider credentials are device-bound envelopes.
 */
export function sealEnvForStorage(dataDir: string, env: Record<string, string>): Record<string, string> {
  const sealed: Record<string, string> = { ...env }
  for (const [key, value] of Object.entries(sealed)) {
    if (!isProtectedEnvKey(key) || value === '' || isSealedSecret(value)) continue
    if (value === SECRET_VALUE_SET || value === SECRET_VALUE_LOCKED) {
      throw new SecretBoxError(`无法保存 ${key}：收到无效的密钥占位符`)
    }
    sealed[key] = sealSecret(dataDir, value)
  }
  return sealed
}

/**
 * Remove protected provider credentials from a map. Used only as a fail-closed
 * migration fallback when the native credential facility is unavailable: the
 * plugin stays usable, but never leaves or consumes the legacy plaintext.
 * @param env - source environment map.
 * @returns a copied map without protected provider credentials.
 */
export function stripProtectedEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isProtectedEnvKey(key)))
}

/**
 * Materialize protected values only for the child process environment.
 * @param dataDir - plugin data directory that scopes the device key.
 * @param env - layered spawn environment, possibly containing envelopes.
 * @returns a copied map with protected envelopes opened in memory.
 */
export function openEnvForSpawn(dataDir: string, env: Record<string, string>): Record<string, string> {
  const opened: Record<string, string> = { ...env }
  for (const [key, value] of Object.entries(opened)) {
    if (!isProtectedEnvKey(key) || !isSealedSecret(value)) continue
    try {
      opened[key] = openSecret(dataDir, value)
    } catch (error) {
      throw new SecretBoxError(
        `无法在这台设备上解密 ${key}。配置可能来自另一台设备，请在设置中重新输入密钥。`,
        { cause: error },
      )
    }
  }
  return opened
}

/**
 * Replace every secret-looking value with an opaque browser sentinel.
 * @param env - host-only environment map.
 * @returns a copied wire-safe map; raw credentials and envelopes are absent.
 */
export function redactEnvForWire(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = { ...env }
  for (const [key, value] of Object.entries(redacted)) {
    if (!isSecretEnvKey(key) || value === '') continue
    redacted[key] = envelopeFitsPlatform(value) ? SECRET_VALUE_SET : SECRET_VALUE_LOCKED
  }
  return redacted
}

/**
 * Resolve keep-existing sentinels in one browser-submitted environment map.
 * Missing keys stay missing, so deleting a secret remains an explicit action.
 * @param incoming - validated submitted values.
 * @param current - host-only existing values.
 * @returns a copied map with sentinels replaced by current values when present.
 */
export function retainWireSecrets(
  incoming: Record<string, string>,
  current: Record<string, string> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...incoming }
  for (const [key, value] of Object.entries(merged)) {
    if ((value !== SECRET_VALUE_SET && value !== SECRET_VALUE_LOCKED) || !isSecretEnvKey(key)) continue
    const previous = current?.[key]
    if (previous === undefined) delete merged[key]
    else merged[key] = previous
  }
  return merged
}

/** Seal one plaintext value with the platform backend. */
function sealSecret(dataDir: string, value: string): string {
  const scope = keyScope(dataDir)
  const { backend, key } = deviceKey(dataDir)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${AES_AAD_VERSION}:${scope}:${backend}`, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [ENVELOPE_PREFIX.slice(0, -1), 'aesgcm', backend, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

/** Open one platform envelope. */
function openSecret(dataDir: string, envelope: string): string {
  const parts = envelope.split('.')
  if (parts[0] !== 'dshcc1') throw new SecretBoxError('不是受支持的 dsh-cc 密钥格式')
  if (parts[1] === 'dpapi') {
    if (process.platform !== 'win32' || parts.length !== 3) throw new SecretBoxError('此密钥只能由原 Windows 用户解密')
    const protectedBase64 = Buffer.from(parts[2] ?? '', 'base64url').toString('base64')
    const plainBase64 = runPowerShell(POWERSHELL_UNPROTECT, protectedBase64)
    return Buffer.from(plainBase64, 'base64').toString('utf8')
  }
  if (parts[1] !== 'aesgcm' || parts.length !== 6) throw new SecretBoxError('不支持的 dsh-cc 密钥格式')
  const backend = parts[2] ?? ''
  const material = deviceKey(dataDir)
  if (material.backend !== backend) throw new SecretBoxError(`此密钥由另一平台后端 ${backend} 加密`)
  try {
    const scope = keyScope(dataDir)
    const decipher = createDecipheriv('aes-256-gcm', material.key, Buffer.from(parts[3] ?? '', 'base64url'))
    decipher.setAAD(Buffer.from(`${AES_AAD_VERSION}:${scope}:${backend}`, 'utf8'))
    decipher.setAuthTag(Buffer.from(parts[4] ?? '', 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(parts[5] ?? '', 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    throw new SecretBoxError('设备密钥不匹配或密文已损坏', { cause: error })
  }
}

/** Run the fixed DPAPI script with base64 on stdin/stdout. */
function runPowerShell(script: string, input: string): string {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  const output = result.stdout.trim()
  if (result.status !== 0 || output === '') {
    const detail = result.stderr.trim() || result.error?.message || `exit ${result.status ?? 'unknown'}`
    throw new SecretBoxError(`Windows DPAPI 调用失败：${detail}`)
  }
  return output
}

/** Load or create one native AES key for the scoped data directory. */
function deviceKey(dataDir: string): { backend: string; key: Buffer } {
  const scope = keyScope(dataDir)
  const cached = keyCache.get(scope)
  if (cached !== undefined) return cached
  let material: { backend: string; key: Buffer }
  if (process.platform === 'win32') material = { backend: 'dpapi-key', key: windowsKey(dataDir) }
  else if (process.platform === 'darwin') material = { backend: 'keychain', key: macKey(scope) }
  else if (process.platform === 'linux') material = linuxKey(dataDir, scope)
  else throw new SecretBoxError(`当前平台 ${process.platform} 不支持设备密钥存储`)
  keyCache.set(scope, material)
  return material
}

/** Stable native-store account for one absolute data directory. */
function keyScope(dataDir: string): string {
  return createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 32)
}

/** Read or create the random AES key wrapped by Windows DPAPI CurrentUser. */
function windowsKey(dataDir: string): Buffer {
  const keyPath = join(dataDir, '.secret-device-key.dpapi')
  const read = (): Buffer | undefined => {
    if (!existsSync(keyPath)) return undefined
    const protectedBase64 = readFileSync(keyPath, 'utf8').trim()
    if (protectedBase64 === '') return undefined
    const plainBase64 = runPowerShell(POWERSHELL_UNPROTECT, protectedBase64)
    return decodeKey(plainBase64)
  }
  const existing = read()
  if (existing !== undefined) return existing
  const generated = randomBytes(KEY_BYTES)
  const protectedBase64 = runPowerShell(POWERSHELL_PROTECT, generated.toString('base64'))
  try {
    writeFileSync(keyPath, protectedBase64, { flag: 'wx', encoding: 'utf8', mode: 0o600 })
    return generated
  } catch (error) {
    const raced = read()
    if (raced !== undefined) return raced
    throw new SecretBoxError('Windows DPAPI 设备密钥写入失败', { cause: error })
  }
}

/** Read or create the macOS Keychain item. */
function macKey(scope: string): Buffer {
  const read = (): Buffer | undefined => {
    const result = spawnSync('security', ['find-generic-password', '-a', scope, '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
    })
    if (result.status !== 0) return undefined
    return decodeKey(result.stdout.trim())
  }
  const existing = read()
  if (existing !== undefined) return existing
  const value = randomBytes(KEY_BYTES).toString('base64')
  // Interactive mode keeps the random key on stdin instead of exposing it in
  // the process argument list. Scope is hex and value is base64, so neither
  // needs shell interpolation or escaping.
  const command = `add-generic-password -U -a ${scope} -s "${KEYCHAIN_SERVICE}" -l dsh-cc-${scope.slice(0, 8)} -w ${value}\nquit\n`
  const created = spawnSync('security', ['-i'], {
    input: command, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  })
  if (created.status !== 0) {
    throw new SecretBoxError(`macOS 钥匙串写入失败：${created.stderr.trim() || '访问被拒绝'}`)
  }
  const key = read()
  if (key === undefined) throw new SecretBoxError('macOS 钥匙串写入后无法读取设备密钥')
  return key
}

/** Read Secret Service on Linux, falling back to a machine-id-bound local key. */
function linuxKey(dataDir: string, scope: string): { backend: string; key: Buffer } {
  const lookupArgs = ['lookup', 'application', 'dsh-cc', 'data-dir', scope]
  const found = spawnSync('secret-tool', lookupArgs, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  })
  if (found.status === 0) {
    const key = decodeKey(found.stdout.trim())
    if (key !== undefined) return { backend: 'secret-service', key }
  }
  if (found.error === undefined) {
    const value = randomBytes(KEY_BYTES).toString('base64')
    const stored = spawnSync('secret-tool', [
      'store', '--label', `dsh-cc ${scope.slice(0, 8)}`,
      'application', 'dsh-cc', 'data-dir', scope,
    ], { input: value, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
    if (stored.status === 0) {
      const check = spawnSync('secret-tool', lookupArgs, {
        encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
      })
      const key = check.status === 0 ? decodeKey(check.stdout.trim()) : undefined
      if (key !== undefined) return { backend: 'secret-service', key }
    }
  }
  return { backend: 'machine-id', key: linuxMachineKey(dataDir, scope) }
}

/** Headless-Linux fallback: random local seed plus the OS machine id. */
function linuxMachineKey(dataDir: string, scope: string): Buffer {
  const machineId = ['/etc/machine-id', '/var/lib/dbus/machine-id']
    .find(path => existsSync(path))
  if (machineId === undefined) throw new SecretBoxError('Linux Secret Service 不可用，且找不到 machine-id')
  const id = readFileSync(machineId, 'utf8').trim()
  if (id === '') throw new SecretBoxError('Linux machine-id 为空，无法绑定设备密钥')
  const seedPath = join(dataDir, '.secret-device-key')
  if (!existsSync(seedPath)) {
    try {
      writeFileSync(seedPath, randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!existsSync(seedPath)) throw error
    }
  }
  const seed = readFileSync(seedPath)
  if (seed.length !== KEY_BYTES) throw new SecretBoxError(`设备密钥文件损坏：${basename(seedPath)}`)
  const uid = userInfo().uid ?? userInfo().username
  return Buffer.from(hkdfSync('sha256', seed, Buffer.from(`${id}:${uid}`), Buffer.from(scope), KEY_BYTES))
}

/** Parse a native-store base64 key and reject wrong lengths. */
function decodeKey(value: string): Buffer | undefined {
  if (value === '') return undefined
  const key = Buffer.from(value, 'base64')
  return key.length === KEY_BYTES ? key : undefined
}

/** Whether a sealed value's backend can at least belong to this OS. */
function envelopeFitsPlatform(value: string): boolean {
  if (!isSealedSecret(value)) return true
  if (value.startsWith(`${ENVELOPE_PREFIX}dpapi.`)
    || value.startsWith(`${ENVELOPE_PREFIX}aesgcm.dpapi-key.`)) return process.platform === 'win32'
  if (value.startsWith(`${ENVELOPE_PREFIX}aesgcm.keychain.`)) return process.platform === 'darwin'
  if (value.startsWith(`${ENVELOPE_PREFIX}aesgcm.secret-service.`)
    || value.startsWith(`${ENVELOPE_PREFIX}aesgcm.machine-id.`)) return process.platform === 'linux'
  return false
}
