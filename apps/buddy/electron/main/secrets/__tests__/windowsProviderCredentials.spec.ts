import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decryptBackupCredentials, encryptBackupCredentials } from '../../../../platform/storage/backupEncryption'
import { exportBackupCredentials, stageBackupCredentials } from '../../storage/backupCredentials'
import { runProfileWrite } from '../../storage/profileWrites'
import { createCredentialVault } from '../CredentialVault'

const old = syntheticCipher()
const current = syntheticCipher()
const fixture = {
  safeAvailable: vi.fn(() => true),
  safeEncrypt: vi.fn(old.encrypt),
  safeDecrypt: vi.fn(old.decrypt),
  dpapiAvailable: vi.fn(() => true),
  protect: vi.fn(current.encrypt),
  unprotect: vi.fn(current.decrypt),
}

// Only the routing decision is simulated; files, write barrier, backup and replacement are real.
vi.mock('../../../../shared/platform/identifiers', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../shared/platform/identifiers')>(),
  isWindows: () => true,
}))
vi.mock('../../../../platform/windows/providerCredentialCipher', () => ({
  createWindowsProviderCipher: () => ({ isAvailable: fixture.dpapiAvailable, encrypt: fixture.protect, decrypt: fixture.unprotect }),
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => '/fixture/app', isPackaged: true },
  safeStorage: {
    isEncryptionAvailable: () => fixture.safeAvailable(),
    getSelectedStorageBackend: () => 'fixture',
    decryptString: (bytes: Buffer) => fixture.safeDecrypt(bytes),
    encryptString: (text: string) => fixture.safeEncrypt(text),
  },
}))
const fault = vi.hoisted(() => ({ failRename: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: (...args: Parameters<typeof fs.rename>) => fault.failRename
      ? Promise.reject(Object.assign(new Error('fixture'), { code: 'EIO' }))
      : fs.rename(...args),
  }
})

function syntheticCipher() {
  const key = randomBytes(32)
  return {
    encrypt(text: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decrypt(bytes: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}
const key = { type: 'api_key', key: 'synthetic-fixture-key' }
const oauth = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 7, accountId: 'fixture-account' }
const digest = (id: string) => createHash('sha256').update(id).digest('hex')
const path = (home: string, id: string) => join(home, 'secrets', 'providers', `${digest(id)}.credential`)
let home: string
beforeEach(async () => {
  home = join(await createTemporaryDirectory('lexora-provider-v2-'), 'buddy')
  await mkdir(dirname(path(home, 'a')), { recursive: true })
})
afterEach(() => {
  vi.resetAllMocks()
  fault.failRename = false
})
async function seed(id: string, value: unknown = key, storedId = id) {
  const bytes = old.encrypt(JSON.stringify({ version: 1, id: storedId, value }))
  await writeFile(path(home, id), bytes)
  return bytes
}

it('migrates valid legacy records independently, rejects mismatches and leaves unreadable bytes untouched across restarts', async () => {
  const original = await seed('api')
  await seed('oauth', oauth)
  const retained = [
    ['wrong-name', await seed('wrong-name', key, 'not-the-filename')],
    ['invalid-schema', await seed('invalid-schema', { type: 'oauth' })],
    ['malformed', Buffer.from('fixture-unreadable')],
    ['future', Buffer.from('LXPC\x03fixture')],
  ] as const
  for (const [id, bytes] of retained)
    await writeFile(path(home, id), bytes)
  const vault = createCredentialVault({ buddyHome: home })
  expect((await vault.scanProviders()).unreadableProviderDigests).toEqual(retained.map(([id]) => digest(id)).sort())
  expect(await readFile(path(home, 'api'))).toEqual(original)
  expect(await vault.migrateWindowsProviders()).toEqual({ migrated: 2, failed: 4 })
  const migrated = await readFile(path(home, 'api'))
  expect(migrated.subarray(0, 5)).toEqual(Buffer.from('LXPC\x02'))
  expect(migrated.includes(Buffer.from(key.key))).toBe(false)
  expect(await vault.read('providers', 'oauth')).toEqual(oauth)
  fixture.safeAvailable.mockReturnValue(false)
  const restarted = createCredentialVault({ buddyHome: home })
  expect(await restarted.migrateWindowsProviders()).toEqual({ migrated: 0, failed: 4 })
  expect(await restarted.read('providers', 'api')).toEqual(key)
  expect(await readFile(path(home, 'api'))).toEqual(migrated)
  for (const [id, bytes] of retained)
    expect(await readFile(path(home, id))).toEqual(bytes)
  await expect(exportBackupCredentials(home, ['providers'])).rejects.toThrow()
})

it.each(['unavailable', 'encrypt', 'verification', 'rename'] as const)('retains the old entry on %s failure and can retry safely', async (failure) => {
  const bytes = await seed('api')
  const vault = createCredentialVault({ buddyHome: home })
  if (failure === 'unavailable')
    fixture.dpapiAvailable.mockReturnValue(false)
  if (failure === 'encrypt')
    fixture.protect.mockImplementation(() => { throw new Error('fixture') })
  if (failure === 'verification')
    fixture.unprotect.mockReturnValue(JSON.stringify({ version: 2, id: 'api', value: { type: 'api_key', key: 'different' } }))
  if (failure === 'rename')
    fault.failRename = true
  expect(await vault.migrateWindowsProviders()).toEqual({ migrated: 0, failed: 1 })
  await expect(vault.write('providers', 'api', key)).rejects.toThrow()
  expect(await readdir(dirname(path(home, 'api')))).toEqual([`${digest('api')}.credential`])
  expect(await readFile(path(home, 'api'))).toEqual(bytes)
  expect(await vault.read('providers', 'api')).toEqual(key)
  expect(fixture.safeEncrypt).not.toHaveBeenCalled()
  vi.resetAllMocks()
  fault.failRename = false
  expect(await vault.migrateWindowsProviders()).toEqual({ migrated: 1, failed: 0 })
})

it('does not read or migrate a provider directory linked into another profile', async () => {
  const original = await seed('api')
  const linked = dirname(path(home, 'api'))
  const external = join(dirname(home), 'other-profile')
  await rename(linked, external)
  await symlink(external, linked, 'junction')
  const vault = createCredentialVault({ buddyHome: home })
  expect(await vault.migrateWindowsProviders()).toEqual({ migrated: 0, failed: 1 })
  await expect(vault.read('providers', 'api')).rejects.toThrow()
  await expect(vault.delete('providers', 'api')).rejects.toThrow()
  await expect(vault.write('providers', 'api', oauth)).rejects.toThrow()
  await expect(exportBackupCredentials(home, ['providers'])).rejects.toThrow()
  expect(await readFile(join(external, `${digest('api')}.credential`))).toEqual(original)
})

it('uses the exclusive profile write barrier, including across vault instances', async () => {
  const original = await seed('api')
  const vault = createCredentialVault({ buddyHome: home })
  const other = createCredentialVault({ buddyHome: home })
  const pending = Promise.withResolvers<void>()
  const inFlight = runProfileWrite(dirname(home), () => pending.promise)
  const migration = vault.migrateWindowsProviders()
  try {
    await expect(other.delete('providers', 'api')).rejects.toThrow()
    expect(await readFile(path(home, 'api'))).toEqual(original)
  }
  finally { pending.resolve() }
  await inFlight
  expect(await migration).toEqual({ migrated: 1, failed: 0 })
  expect(await other.read('providers', 'api')).toEqual(key)
})

it('reuses only authenticated list metadata, invalidates by ciphertext, and never exports cached or partial secrets', async () => {
  const vault = createCredentialVault({ buddyHome: home })
  await vault.write('providers', 'api', key)
  const restarted = createCredentialVault({ buddyHome: home })
  const inventory = { providers: [{ providerId: 'api', type: 'api_key' }], unreadableProviderDigests: [] }
  fixture.unprotect.mockClear()
  expect(await restarted.scanProviders()).toEqual(inventory)
  expect(await restarted.scanProviders()).toEqual(inventory)
  expect(fixture.unprotect).toHaveBeenCalledTimes(1)
  const damaged = await readFile(path(home, 'api'))
  damaged[damaged.length - 1] ^= 1
  await writeFile(path(home, 'api'), damaged)
  expect(await restarted.scanProviders()).toEqual({ providers: [], unreadableProviderDigests: [digest('api')] })
  await expect(restarted.listProviders()).rejects.toThrow()
  await expect(exportBackupCredentials(home, ['providers'])).rejects.toThrow()
  expect(await readFile(path(home, 'api'))).toEqual(damaged)
  expect(fixture.safeAvailable).not.toHaveBeenCalled()
})

it('evicts authenticated metadata after a key failure and rejects destructive writes until the key returns', async () => {
  const vault = createCredentialVault({ buddyHome: home })
  await vault.write('providers', 'api', key)
  const bytes = await readFile(path(home, 'api'))
  fixture.unprotect.mockImplementation(() => {
    throw new Error('synthetic-key-unavailable')
  })
  await expect(vault.read('providers', 'api')).rejects.toThrow()
  expect(await vault.scanProviders()).toEqual({ providers: [], unreadableProviderDigests: [digest('api')] })
  await expect(vault.delete('providers', 'api')).rejects.toThrow()
  await expect(vault.write('providers', 'api', oauth)).rejects.toThrow()
  expect(await readFile(path(home, 'api'))).toEqual(bytes)
  fixture.unprotect.mockReset()
  expect((await vault.scanProviders()).providers).toEqual([{ providerId: 'api', type: 'api_key' }])
  await vault.delete('providers', 'api')
  expect(await vault.read('providers', 'api')).toBeNull()
})

it('exports a password-protected backup, skipping OAuth, and restores v2 without the legacy key', async () => {
  await seed('api')
  await seed('subscription', oauth)
  const source = createCredentialVault({ buddyHome: home })
  await source.write('connectors', 'other', { token: 'fixture-token' })
  const asBackup = () => exportBackupCredentials(home, ['providers'])
  expect(await asBackup()).toEqual([{ namespace: 'providers', id: 'api', value: key }])
  expect(await source.migrateWindowsProviders()).toEqual({ migrated: 2, failed: 0 })
  fixture.safeAvailable.mockReturnValue(false)
  await expect(exportBackupCredentials(home, ['connections', 'providers'])).rejects.toThrow('CREDENTIAL_STORE_UNAVAILABLE')
  const bytes = await encryptBackupCredentials(await asBackup(), 'synthetic-password')
  expect(Buffer.from(bytes).includes(Buffer.from(key.key))).toBe(false)
  await expect(decryptBackupCredentials(bytes, 'wrong-password')).rejects.toThrow()
  const destination = join(dirname(home), 'stage')
  await stageBackupCredentials(destination, await decryptBackupCredentials(bytes, 'synthetic-password'), ['providers'])
  expect((await readFile(path(destination, 'api'))).subarray(0, 5)).toEqual(Buffer.from('LXPC\x02'))
  const restored = createCredentialVault({ buddyHome: destination })
  expect(await restored.read('providers', 'api')).toEqual(key)
  expect(await restored.read('providers', 'subscription')).toBeNull()
})
