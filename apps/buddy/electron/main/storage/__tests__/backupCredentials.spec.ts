import { Buffer } from 'node:buffer'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { safeStorage } from 'electron'
import { expect, it, vi } from 'vitest'
import { createCredentialVault } from '../../secrets/CredentialVault'
import { exportBackupCredentials, stageBackupCredentials } from '../backupCredentials'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'fixture',
    encryptString: (value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0x9D)),
    decryptString: (value: Buffer) => Buffer.from(value.map(byte => byte ^ 0x9D)).toString(),
  },
}))

it('exports and restores plugin secrets only in the selected scope without overwriting unrelated credentials', async () => {
  const root = await createTemporaryDirectory('lexora-backup-credentials-')
  const home = join(root, 'source')
  const destination = join(root, 'destination')
  const source = createCredentialVault({ buddyHome: home })
  const target = createCredentialVault({ buddyHome: destination })
  const value = [{ id: 'images', origin: 'https://images.invalid', token: 'synthetic-plugin-token' }]
  const retained = { type: 'api_key', key: 'synthetic-retained' }
  await source.write('extensions', 'tests.images', value)
  await source.write('providers', 'provider', { type: 'api_key', key: 'synthetic-provider' })
  await target.write('providers', 'provider', retained)
  const directory = join(home, 'secrets/extensions')
  const [file] = await readdir(directory)
  expect(file).toBeDefined()
  expect((await readFile(join(directory, file!))).includes(Buffer.from('synthetic-plugin-token'))).toBe(false)
  const exported = await exportBackupCredentials(home, ['plugins'])
  expect(exported).toEqual([{ namespace: 'extensions', id: 'tests.images', value }])
  expect(await exportBackupCredentials(home, ['tasks'])).toEqual([])
  expect(await exportBackupCredentials(home, ['providers'])).toEqual([
    { namespace: 'providers', id: 'provider', value: { type: 'api_key', key: 'synthetic-provider' } },
  ])
  await stageBackupCredentials(destination, exported, ['tasks'])
  expect(await target.read('extensions', 'tests.images')).toBeNull()
  await stageBackupCredentials(destination, exported, ['plugins'])
  expect(await target.read('extensions', 'tests.images')).toEqual(value)
  expect(await target.read('providers', 'provider')).toEqual(retained)
  expect(await source.read('extensions', 'tests.images')).toEqual(value)
})

it('can delete plugin secrets without an available key store while preserving other namespaces', async () => {
  const buddyHome = await createTemporaryDirectory('lexora-plugin-vault-')
  const vault = createCredentialVault({ buddyHome })
  await vault.write('extensions', 'tests.images', [{ id: 'images', origin: 'https://images.invalid', token: 'synthetic-token' }])
  await vault.write('providers', 'tests.images', { type: 'api_key', key: 'synthetic-retained' })
  const availability = vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
  await expect(vault.read('extensions', 'tests.images')).rejects.toThrow('encryption is unavailable')
  await expect(exportBackupCredentials(buddyHome, ['plugins'])).rejects.toThrow('CREDENTIAL_STORE_UNAVAILABLE')
  await vault.delete('extensions', 'tests.images')
  availability.mockRestore()
  expect(await vault.read('extensions', 'tests.images')).toBeNull()
  expect(await vault.read('providers', 'tests.images')).toEqual({ type: 'api_key', key: 'synthetic-retained' })
})
