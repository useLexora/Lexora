import type { Buffer } from 'node:buffer'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { CredentialVaultFailure } from '../../../shared/diagnostics/credentialVaultFailure'
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
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { credentialVaultSystemCodeSchema } from '../../../shared/diagnostics/credentialVaultFailure'
import { OPERATING_SYSTEM } from '../../../shared/platform/identifiers'

type LocalCredentialNamespace = CredentialNamespace | 'sync' | 'backup' | 'images'

const SECRET_FILE_SUFFIX = '.credential'

export interface SecretCipher {
  available: () => boolean
  decrypt: (value: Buffer) => string
  encrypt: (value: string) => Buffer
}

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

export type CredentialVaultPhase = CredentialVaultFailure['phase']

export class CredentialVaultError extends Error {
  readonly code = 'CREDENTIAL_VAULT_FAILED'
  readonly systemCode: CredentialVaultFailure['systemCode']
  readonly phase: CredentialVaultPhase
  readonly reason: CredentialVaultFailure['reason']

  constructor(phase: CredentialVaultPhase, cause?: unknown, reason: CredentialVaultFailure['reason'] = 'operation_failed') {
    super(`Lexora Buddy credential vault failed during ${phase}`)
    this.name = 'CredentialVaultError'
    this.phase = phase
    this.reason = reason
    const code = credentialVaultSystemCodeSchema.safeParse((cause as NodeJS.ErrnoException | undefined)?.code)
    this.systemCode = code.success ? code.data : undefined
  }
}

export function createCredentialVault(
  options: CreateCredentialVaultOptions = {},
): CredentialVault {
  const root = join(options.buddyHome ?? join(homedir(), '.lexora', 'buddy'), 'secrets')
  const cipher = options.cipher ?? createSafeStorageCipher()
  const report = safeDiagnosticReporter(options.reportDiagnostic)
  const run = async <T>(operation: CredentialVaultFailure['operation'], namespace: LocalCredentialNamespace, action: () => Promise<T>): Promise<T> => {
    try {
      assertAvailable(cipher)
      return await action()
    }
    catch (error) {
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
      throw failure
    }
  }

  return {
    delete: (namespace, id) => run('delete', namespace, async () => {
      try {
        await unlink(resolveSecretPath(root, namespace, id))
      }
      catch (error) {
        if (!isFileNotFound(error))
          throw new CredentialVaultError('delete_file', error)
      }
    }),
    listProviders: () => run('list', 'providers', async () => {
      const directory = resolveNamespacePath(root, 'providers')
      let files: string[]
      try {
        files = await readdir(directory)
      }
      catch (error) {
        if (isFileNotFound(error))
          return []
        throw new CredentialVaultError('list_directory', error)
      }

      const providers = await Promise.all(files
        .filter(file => file.endsWith(SECRET_FILE_SUFFIX))
        .sort()
        .map(async (file) => {
          const envelope = decryptEnvelope(cipher, await vaultStep('read_file', () => readFile(join(directory, file))))
          const type = readCredentialType(envelope.value)
          if (!type)
            throw new CredentialVaultError('validate', undefined, 'invalid_credential_type')
          return { providerId: envelope.id, type }
        }))
      return providers.sort((left, right) => left.providerId.localeCompare(right.providerId))
    }),
    read: (namespace, id) => run('read', namespace, async () => {
      let encrypted: Buffer
      try {
        encrypted = await readFile(resolveSecretPath(root, namespace, id))
      }
      catch (error) {
        if (isFileNotFound(error))
          return null
        throw new CredentialVaultError('read_file', error)
      }
      const envelope = decryptEnvelope(cipher, encrypted)
      if (envelope.id !== id)
        throw new CredentialVaultError('validate', undefined, 'identifier_mismatch')
      return envelope.value
    }),
    write: (namespace, id, value) => run('write', namespace, async () => {
      const directory = resolveNamespacePath(root, namespace)
      await vaultStep('prepare_directory', async () => {
        await ensurePrivateDirectory(root)
        await ensurePrivateDirectory(directory)
      })

      const destination = resolveSecretPath(root, namespace, id)
      const temporary = join(directory, `.${randomUUID()}.tmp`)
      const envelope: VaultEnvelope = { id, value, version: 1 }
      const text = syncVaultStep('serialize', () => JSON.stringify(envelope))
      const encrypted = syncVaultStep('encrypt', () => cipher.encrypt(text))
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
        throw new CredentialVaultError('write_file', error)
      }
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

function assertAvailable(cipher: SecretCipher): void {
  if (!syncVaultStep('availability', () => cipher.available()))
    throw new CredentialStoreUnavailableError()
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true })
  await chmod(path, 0o700)
}

function resolveNamespacePath(root: string, namespace: LocalCredentialNamespace): string {
  return join(root, namespace)
}

function resolveSecretPath(root: string, namespace: LocalCredentialNamespace, id: string): string {
  const name = createHash('sha256').update(id).digest('hex')
  return join(resolveNamespacePath(root, namespace), `${name}${SECRET_FILE_SUFFIX}`)
}

async function vaultStep<T>(phase: CredentialVaultPhase, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  }
  catch (error) {
    throw new CredentialVaultError(phase, error)
  }
}

function syncVaultStep<T>(phase: CredentialVaultPhase, operation: () => T): T {
  try {
    return operation()
  }
  catch (error) {
    throw new CredentialVaultError(phase, error)
  }
}

function decryptEnvelope(cipher: SecretCipher, encrypted: Buffer): VaultEnvelope {
  const text = syncVaultStep('decrypt', () => cipher.decrypt(encrypted))
  const value: unknown = syncVaultStep('parse', () => JSON.parse(text))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CredentialVaultError('validate', undefined, 'invalid_envelope')

  const envelope = value as Partial<VaultEnvelope>
  if (typeof envelope.version !== 'number' || typeof envelope.id !== 'string' || !envelope.id || !('value' in envelope))
    throw new CredentialVaultError('validate', undefined, 'invalid_envelope')
  if (envelope.version !== 1)
    throw new CredentialVaultError('validate', undefined, 'unsupported_version')
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
