import type { Buffer } from 'node:buffer'
import type { CredentialVaultFailure } from '../../../shared/diagnostics/credentialVaultFailure'
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { credentialVaultSystemCodeSchema } from '../../../shared/diagnostics/credentialVaultFailure'

export const SECRET_FILE_SUFFIX = '.credential'

export interface SecretCipher {
  available: () => boolean
  decrypt: (value: Buffer) => string
  encrypt: (value: string) => Buffer
}

export interface VaultEnvelope {
  id: string
  value: unknown
  version: number
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

export function assertAvailable(cipher: SecretCipher): void {
  if (!syncVaultStep('availability', () => cipher.available()))
    throw new CredentialStoreUnavailableError()
}

export function credentialFileName(id: string): string {
  return `${createHash('sha256').update(id).digest('hex')}${SECRET_FILE_SUFFIX}`
}

export async function vaultStep<T>(phase: CredentialVaultPhase, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  }
  catch (error) {
    throw new CredentialVaultError(phase, error)
  }
}

export function syncVaultStep<T>(phase: CredentialVaultPhase, operation: () => T): T {
  try {
    return operation()
  }
  catch (error) {
    throw new CredentialVaultError(phase, error)
  }
}

export function parseEnvelope(text: string, version: 1 | 2): VaultEnvelope {
  const value: unknown = syncVaultStep('parse', () => JSON.parse(text))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CredentialVaultError('validate', undefined, 'invalid_envelope')
  const envelope = value as Partial<VaultEnvelope>
  if (typeof envelope.version !== 'number' || typeof envelope.id !== 'string' || !envelope.id || !('value' in envelope))
    throw new CredentialVaultError('validate', undefined, 'invalid_envelope')
  if (envelope.version !== version)
    throw new CredentialVaultError('validate', undefined, 'unsupported_version')
  return envelope as VaultEnvelope
}

export function decryptLegacyEnvelope(cipher: SecretCipher, encrypted: Buffer): VaultEnvelope {
  return parseEnvelope(syncVaultStep('decrypt', () => cipher.decrypt(encrypted)), 1)
}

export async function replaceCredentialFile(destination: string, bytes: Buffer, verify?: (persisted: Buffer) => void): Promise<void> {
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`)
  const handle = await vaultStep('write_file', () => open(temporary, 'wx', 0o600))
  try {
    await vaultStep('write_file', async () => {
      try {
        await handle.writeFile(bytes)
        await handle.chmod(0o600)
        await handle.sync()
      }
      finally { await handle.close() }
    })
    if (verify)
      verify(await vaultStep('read_file', () => readFile(temporary)))
    // The destination is untouched until this final (same-directory) commit.
    await vaultStep('write_file', () => rename(temporary, destination))
  }
  catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
