import type { SecretCipher, VaultEnvelope } from './credentialFile'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { credentialSchema, providerCredentialParamsSchema } from '../../../shared/runtime/credentialProtocol'
import { assertAvailable, credentialFileName, CredentialStoreUnavailableError, CredentialVaultError, decryptLegacyEnvelope, parseEnvelope, replaceCredentialFile, syncVaultStep } from './credentialFile'

const MAGIC = Buffer.from('LXPC', 'ascii')
const V2 = Buffer.concat([MAGIC, Buffer.from([2])])

interface ProviderMetadata { providerId: string, type: 'api_key' | 'oauth' }

function isVersion2(bytes: Buffer): boolean {
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC))
    return false
  if (!bytes.subarray(0, V2.length).equals(V2))
    throw new CredentialVaultError('validate', undefined, 'unsupported_version')
  return true
}

export function providerMetadata(file: string, envelope: VaultEnvelope): ProviderMetadata {
  const id = providerCredentialParamsSchema.safeParse({ providerId: envelope.id })
  if (!id.success || id.data.providerId !== envelope.id || credentialFileName(envelope.id) !== file)
    throw new CredentialVaultError('validate', undefined, 'identifier_mismatch')
  const credential = credentialSchema.safeParse(envelope.value)
  if (!credential.success)
    throw new CredentialVaultError('validate', undefined, 'invalid_credential_type')
  return { providerId: envelope.id, type: credential.data.type }
}

export async function assertLocalProviderDirectory(directory: string) {
  for (const path of [dirname(dirname(directory)), dirname(directory), directory]) {
    if (!(await lstat(path)).isDirectory())
      throw new CredentialVaultError('list_directory')
  }
}

export async function readLocalProviderFile(path: string) {
  if (!(await lstat(path)).isFile())
    throw new CredentialVaultError('read_file')
  return readFile(path)
}

export function windowsProviderFiles(dpapi: SecretCipher, legacy: SecretCipher) {
  const cache = new Map<string, { fingerprint: string, metadata: ProviderMetadata }>()
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const decryptV2 = (bytes: Buffer) => syncVaultStep('decrypt', () => dpapi.decrypt(bytes.subarray(V2.length)))
  const decode = (bytes: Buffer) => {
    if (isVersion2(bytes)) {
      assertAvailable(dpapi)
      return parseEnvelope(decryptV2(bytes), 2)
    }
    assertAvailable(legacy)
    return decryptLegacyEnvelope(legacy, bytes)
  }
  const write = async (path: string, id: string, value: unknown) => {
    assertAvailable(dpapi)
    const envelope = { version: 2, id, value }
    const file = basename(path)
    const metadata = providerMetadata(file, envelope)
    const text = syncVaultStep('serialize', () => JSON.stringify(envelope))
    const encrypted = syncVaultStep('encrypt', () => Buffer.concat([V2, dpapi.encrypt(text)]))
    await replaceCredentialFile(path, encrypted, (persisted) => {
      if (!isVersion2(persisted) || decryptV2(persisted) !== text)
        throw new CredentialVaultError('validate', undefined, 'invalid_envelope')
    })
    cache.set(file, { fingerprint: digest(encrypted), metadata })
  }
  return {
    assertWritable: () => assertAvailable(dpapi),
    decode,
    write,
    async readExisting(directory: string, id: string) {
      const file = credentialFileName(id)
      try {
        await assertLocalProviderDirectory(directory)
        const envelope = decode(await readLocalProviderFile(join(directory, file)))
        if (envelope.id !== id)
          throw new CredentialVaultError('validate', undefined, 'identifier_mismatch')
        providerMetadata(file, envelope)
        return envelope
      }
      catch (error) {
        cache.delete(file)
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
          return null
        if (error instanceof CredentialVaultError || error instanceof CredentialStoreUnavailableError)
          throw error
        throw new CredentialVaultError('read_file', error)
      }
    },
    metadata(file: string, bytes: Buffer, useCache: boolean) {
      if (!isVersion2(bytes))
        return providerMetadata(file, decode(bytes))
      assertAvailable(dpapi)
      const fingerprint = digest(bytes)
      const cached = cache.get(file)
      if (useCache && cached?.fingerprint === fingerprint)
        return { ...cached.metadata }
      const metadata = providerMetadata(file, parseEnvelope(decryptV2(bytes), 2))
      cache.set(file, { fingerprint, metadata: { ...metadata } })
      return metadata
    },
    forget: (file: string) => cache.delete(file),
    async migrate(path: string, bytes: Buffer) {
      if (isVersion2(bytes))
        return false
      assertAvailable(dpapi)
      const envelope = decode(bytes)
      if (Object.keys(envelope).some(key => !['id', 'version', 'value'].includes(key)))
        throw new CredentialVaultError('validate', undefined, 'invalid_envelope')
      providerMetadata(basename(path), envelope)
      await write(path, envelope.id, envelope.value)
      return true
    },
  }
}
