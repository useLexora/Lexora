import type { Buffer } from 'node:buffer'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { CredentialVaultFailure } from '../../../shared/diagnostics/credentialVaultFailure'
import type { CredentialNamespace, ProviderCredentialInventory } from '../../../shared/runtime/credentialProtocol'
import type { SecretCipher } from './credentialFile'
import { chmod, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { app, safeStorage } from 'electron'
import { createWindowsProviderCipher } from '../../../platform/windows/providerCredentialCipher'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { isWindows, OPERATING_SYSTEM } from '../../../shared/platform/identifiers'
import { runProfileWrite, withProfileWritesStopped } from '../storage/profileWrites'
import { assertAvailable, credentialFileName, CredentialStoreUnavailableError, CredentialVaultError, decryptLegacyEnvelope, replaceCredentialFile, SECRET_FILE_SUFFIX, syncVaultStep, vaultStep } from './credentialFile'
import { assertLocalProviderDirectory, providerMetadata, readLocalProviderFile, windowsProviderFiles } from './providerCredentialFiles'

export type { CredentialVaultPhase, SecretCipher } from './credentialFile'
export { CredentialStoreUnavailableError, CredentialVaultError } from './credentialFile'

type LocalCredentialNamespace = CredentialNamespace | 'sync' | 'backup' | 'extensions' | 'images'

export interface CredentialVault {
  delete: (namespace: LocalCredentialNamespace, id: string) => Promise<void>
  listProviders: () => Promise<ReadonlyArray<{
    providerId: string
    type: 'api_key' | 'oauth'
  }>>
  read: (namespace: LocalCredentialNamespace, id: string) => Promise<unknown | null>
  write: (namespace: LocalCredentialNamespace, id: string, value: unknown) => Promise<void>
}

export interface CreateCredentialVaultOptions {
  buddyHome?: string
  cipher?: SecretCipher
  reportDiagnostic?: ApplicationDiagnosticReporter
}

interface LocalCredentialVault extends CredentialVault {
  scanProviders: () => Promise<ProviderCredentialInventory>
  exportProviderApiKeys: () => Promise<{ id: string, value: unknown }[]>
  migrateWindowsProviders: () => Promise<{ migrated: number, failed: number }>
}

export function createCredentialVault(options: CreateCredentialVaultOptions = {}): LocalCredentialVault {
  const root = join(options.buddyHome ?? join(homedir(), '.lexora', 'buddy'), 'secrets')
  const profileRoot = dirname(dirname(root))
  const providers = join(root, 'providers')
  const cipher = options.cipher ?? createSafeStorageCipher()
  const dpapi = isWindows(process.platform) ? createWindowsProviderCipher({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }) : undefined
  const windows = dpapi && windowsProviderFiles({ available: dpapi.isAvailable, decrypt: dpapi.decrypt, encrypt: dpapi.encrypt }, cipher)
  const report = safeDiagnosticReporter(options.reportDiagnostic)
  const reportFailure = (operation: CredentialVaultFailure['operation'], namespace: LocalCredentialNamespace, error: unknown) => {
    const failure = error instanceof CredentialStoreUnavailableError || error instanceof CredentialVaultError
      ? error
      : new CredentialVaultError('unknown', error)
    const unavailable = failure instanceof CredentialStoreUnavailableError
    const detail: CredentialVaultFailure = {
      kind: 'credential_vault',
      operation,
      namespace,
      phase: unavailable ? 'availability' : failure.phase,
      reason: unavailable ? 'unavailable' : failure.reason,
      ...(!unavailable && failure.systemCode ? { systemCode: failure.systemCode } : {}),
    }
    report({ event: `credential.${detail.phase}.failed`, component: 'desktop.credentials', level: 'warn', errorCode: unavailable ? 'CREDENTIAL_STORE_UNAVAILABLE' : 'CREDENTIAL_STORE_FAILURE', failure: detail })
    return failure
  }
  const run = async <T>(operation: CredentialVaultFailure['operation'], namespace: LocalCredentialNamespace, action: () => Promise<T>): Promise<T> => {
    try {
      if (operation !== 'delete' && (!windows || namespace !== 'providers'))
        assertAvailable(cipher)
      return await (operation === 'write' || operation === 'delete' ? runProfileWrite(profileRoot, action) : action())
    }
    catch (error) {
      throw reportFailure(operation, namespace, error)
    }
  }
  const providerNames = async () => {
    try {
      if (windows)
        await assertLocalProviderDirectory(providers)
      return (await readdir(providers)).filter(name => name.endsWith(SECRET_FILE_SUFFIX)).sort()
    }
    catch (error) {
      if (isFileNotFound(error))
        return []
      throw new CredentialVaultError('list_directory', error)
    }
  }
  const readProviderFile = (file: string) => vaultStep('read_file', async () => {
    const path = join(providers, file)
    return windows ? readLocalProviderFile(path) : readFile(path)
  })
  const scanProviders = (strict: boolean) => run('list', 'providers', async () => {
    const inventory: ProviderCredentialInventory = { providers: [], unreadableProviderDigests: [] }
    for (const file of await providerNames()) {
      try {
        const bytes = await readProviderFile(file)
        inventory.providers.push(windows ? windows.metadata(file, bytes, !strict) : providerMetadata(file, decryptLegacyEnvelope(cipher, bytes)))
      }
      catch (error) {
        windows?.forget(file)
        if (strict)
          throw error
        reportFailure('list', 'providers', error)
        const digest = file.slice(0, -SECRET_FILE_SUFFIX.length)
        if (/^[a-f0-9]{64}$/.test(digest))
          inventory.unreadableProviderDigests.push(digest)
      }
    }
    inventory.providers.sort((left, right) => left.providerId.localeCompare(right.providerId))
    return inventory
  })
  return {
    async migrateWindowsProviders() {
      const result = { migrated: 0, failed: 0 }
      if (!windows)
        return result
      try {
        await withProfileWritesStopped(profileRoot, async () => {
          for (const file of await providerNames()) {
            try {
              if (await windows.migrate(join(providers, file), await readProviderFile(file)))
                result.migrated++
            }
            catch (error) {
              result.failed++
              reportFailure('write', 'providers', error)
            }
          }
        })
      }
      catch (error) {
        result.failed++
        reportFailure('write', 'providers', error)
      }
      return result
    },
    exportProviderApiKeys: () => run('list', 'providers', async () => {
      const keys: { id: string, value: unknown }[] = []
      for (const file of await providerNames()) {
        const bytes = await readProviderFile(file)
        const envelope = windows ? windows.decode(bytes) : decryptLegacyEnvelope(cipher, bytes)
        if (providerMetadata(file, envelope).type === 'api_key')
          keys.push({ id: envelope.id, value: envelope.value })
      }
      return keys
    }),
    delete: (namespace, id) => run('delete', namespace, async () => {
      try {
        if (windows && namespace === 'providers' && !await windows.readExisting(providers, id))
          return
        await unlink(join(root, namespace, credentialFileName(id)))
        if (namespace === 'providers')
          windows?.forget(credentialFileName(id))
      }
      catch (error) {
        if (error instanceof CredentialVaultError || error instanceof CredentialStoreUnavailableError)
          throw error
        if (!isFileNotFound(error))
          throw new CredentialVaultError('delete_file', error)
      }
    }),
    listProviders: async () => (await scanProviders(true)).providers,
    scanProviders: () => scanProviders(false),
    read: (namespace, id) => run('read', namespace, async () => {
      if (windows && namespace === 'providers')
        return (await windows.readExisting(providers, id))?.value ?? null
      const file = credentialFileName(id)
      let encrypted: Buffer
      try {
        encrypted = await readFile(join(root, namespace, file))
      }
      catch (error) {
        if (isFileNotFound(error))
          return null
        throw new CredentialVaultError('read_file', error)
      }
      const envelope = decryptLegacyEnvelope(cipher, encrypted)
      if (envelope.id !== id)
        throw new CredentialVaultError('validate', undefined, 'identifier_mismatch')
      return envelope.value
    }),
    write: (namespace, id, value) => run('write', namespace, async () => {
      const directory = join(root, namespace)
      if (windows && namespace === 'providers') {
        windows.assertWritable()
        await windows.readExisting(providers, id)
      }
      await vaultStep('prepare_directory', async () => {
        await ensurePrivateDirectory(root)
        await ensurePrivateDirectory(directory)
      })
      const destination = join(directory, credentialFileName(id))
      if (windows && namespace === 'providers')
        return windows.write(destination, id, value)
      const text = syncVaultStep('serialize', () => JSON.stringify({ id, value, version: 1 }))
      await replaceCredentialFile(destination, syncVaultStep('encrypt', () => cipher.encrypt(text)))
    }),
  }
}

export function createSafeStorageCipher(): SecretCipher {
  const platform = process.platform
  return {
    available: () => isSafeStorageBackendSecure({
      backend: platform === OPERATING_SYSTEM.Linux ? safeStorage.getSelectedStorageBackend() : 'unknown',
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      platform,
    }),
    decrypt: value => safeStorage.decryptString(value),
    encrypt: value => safeStorage.encryptString(value),
  }
}

export function isSafeStorageBackendSecure(input: {
  backend: string
  encryptionAvailable: boolean
  platform: NodeJS.Platform
}): boolean {
  return input.encryptionAvailable
    && !(input.platform === OPERATING_SYSTEM.Linux && input.backend === 'basic_text')
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true })
  await chmod(path, 0o700)
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
