import type { Buffer } from 'node:buffer'
import type { CredentialNamespace } from '../../../shared/runtime/credentialProtocol'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { safeStorage } from 'electron'
import { OPERATING_SYSTEM } from '../../../shared/platform/identifiers'

const SECRET_FILE_SUFFIX = '.credential'

export interface SecretCipher {
  available: () => boolean
  decrypt: (value: Buffer) => string
  encrypt: (value: string) => Buffer
}

export interface CredentialVault {
  delete: (namespace: CredentialNamespace, id: string) => Promise<void>
  listProviders: () => Promise<ReadonlyArray<{
    providerId: string
    type: 'api_key' | 'oauth'
  }>>
  read: (namespace: CredentialNamespace, id: string) => Promise<unknown | null>
  write: (namespace: CredentialNamespace, id: string, value: unknown) => Promise<void>
}

export interface CreateCredentialVaultOptions {
  buddyHome?: string
  cipher?: SecretCipher
}

interface VaultEnvelope {
  id: string
  value: unknown
  version: 1
}

export class CredentialStoreUnavailableError extends Error {
  readonly code = 'CREDENTIAL_STORE_UNAVAILABLE'

  constructor() {
    super('Lexora Buddy credential encryption is unavailable')
    this.name = 'CredentialStoreUnavailableError'
  }
}

export function createCredentialVault(
  options: CreateCredentialVaultOptions = {},
): CredentialVault {
  const root = join(options.buddyHome ?? join(homedir(), '.lexora', 'buddy'), 'secrets')
  const cipher = options.cipher ?? createSafeStorageCipher()

  return {
    async delete(namespace, id) {
      assertAvailable(cipher)
      try {
        await unlink(resolveSecretPath(root, namespace, id))
      }
      catch (error) {
        if (!isFileNotFound(error))
          throw error
      }
    },
    async listProviders() {
      assertAvailable(cipher)
      const directory = resolveNamespacePath(root, 'providers')
      let files: string[]
      try {
        files = await readdir(directory)
      }
      catch (error) {
        if (isFileNotFound(error))
          return []
        throw error
      }

      const providers = await Promise.all(files
        .filter(file => file.endsWith(SECRET_FILE_SUFFIX))
        .sort()
        .map(async (file) => {
          const envelope = decryptEnvelope(cipher, await readFile(join(directory, file)))
          const type = readCredentialType(envelope.value)
          if (!type)
            throw new Error('Lexora Buddy provider credential is invalid')
          return { providerId: envelope.id, type }
        }))
      return providers.sort((left, right) => left.providerId.localeCompare(right.providerId))
    },
    async read(namespace, id) {
      assertAvailable(cipher)
      try {
        const encrypted = await readFile(resolveSecretPath(root, namespace, id))
        const envelope = decryptEnvelope(cipher, encrypted)
        if (envelope.id !== id)
          throw new Error('Lexora Buddy credential identifier does not match its vault entry')
        return envelope.value
      }
      catch (error) {
        if (isFileNotFound(error))
          return null
        throw error
      }
    },
    async write(namespace, id, value) {
      assertAvailable(cipher)
      const directory = resolveNamespacePath(root, namespace)
      await ensurePrivateDirectory(root)
      await ensurePrivateDirectory(directory)

      const destination = resolveSecretPath(root, namespace, id)
      const temporary = join(directory, `.${randomUUID()}.tmp`)
      const envelope: VaultEnvelope = { id, value, version: 1 }
      const encrypted = cipher.encrypt(JSON.stringify(envelope))
      let handle
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(encrypted)
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temporary, destination)
        await chmod(destination, 0o600)
      }
      catch (error) {
        await handle?.close().catch(() => {})
        await unlink(temporary).catch(() => {})
        throw error
      }
    },
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

function assertAvailable(cipher: SecretCipher): void {
  if (!cipher.available())
    throw new CredentialStoreUnavailableError()
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true })
  await chmod(path, 0o700)
}

function resolveNamespacePath(root: string, namespace: CredentialNamespace): string {
  return join(root, namespace)
}

function resolveSecretPath(root: string, namespace: CredentialNamespace, id: string): string {
  const name = createHash('sha256').update(id).digest('hex')
  return join(resolveNamespacePath(root, namespace), `${name}${SECRET_FILE_SUFFIX}`)
}

function decryptEnvelope(cipher: SecretCipher, encrypted: Buffer): VaultEnvelope {
  const value: unknown = JSON.parse(cipher.decrypt(encrypted))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Lexora Buddy credential envelope is invalid')

  const envelope = value as Partial<VaultEnvelope>
  if (envelope.version !== 1 || typeof envelope.id !== 'string' || !('value' in envelope))
    throw new Error('Lexora Buddy credential envelope is invalid')
  return envelope as VaultEnvelope
}

function readCredentialType(value: unknown): 'api_key' | 'oauth' | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null
  const type = (value as { type?: unknown }).type
  return type === 'api_key' || type === 'oauth' ? type : null
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
