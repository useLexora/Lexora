import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import type { SecretCipher } from '../CredentialVault'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'

import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeRpcPeer } from '../../../../platform/ipc/runtimeRpcPeer'
import { DesktopDiagnosticLogger } from '../../desktopDiagnostics'
import { createApplicationDiagnosticBundle } from '../../diagnostics/applicationDiagnosticBundle'
import { ApplicationLogReader } from '../../diagnostics/ApplicationLogReader'
import { exportBackupCredentials } from '../../storage/backupCredentials'
import {
  createCredentialVault,
  CredentialStoreUnavailableError,
  CredentialVaultError,
  isSafeStorageBackendSecure,
} from '../CredentialVault'
import { isAllowedExternalUrl, registerCredentialHostRpc } from '../registerCredentialHostRpc'

const reversibleCipher: SecretCipher = {
  available: () => true,
  decrypt: value => Buffer.from([...value].map(byte => byte ^ 0xA5)).toString('utf8'),
  encrypt: value => Buffer.from([...Buffer.from(value, 'utf8')].map(byte => byte ^ 0xA5)),
}

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'fixture',
    decryptString: (value: Buffer) => reversibleCipher.decrypt(value),
  },
  shell: {},
}))

describe('credentialVault', () => {
  it('atomically persists encrypted provider credentials with private permissions', async () => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const vault = createCredentialVault({ buddyHome, cipher: reversibleCipher })

    await vault.write('providers', 'openai-codex', {
      type: 'api_key',
      key: 'sk-test-secret',
    })

    await expect(vault.read('providers', 'openai-codex')).resolves.toEqual({
      type: 'api_key',
      key: 'sk-test-secret',
    })
    await expect(vault.listProviders()).resolves.toEqual([
      { providerId: 'openai-codex', type: 'api_key' },
    ])

    const providerDirectory = join(buddyHome, 'secrets', 'providers')
    const files = await readdir(providerDirectory)
    expect(files).toHaveLength(1)
    const persisted = await readFile(join(providerDirectory, files[0]!))
    expect(persisted.includes(Buffer.from('sk-test-secret'))).toBe(false)
    expect((await stat(providerDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(providerDirectory, files[0]!))).mode & 0o777).toBe(0o600)
  })

  it('returns only healthy metadata and canonical digests, without changing unreadable files', async () => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    let available = true
    const vault = createCredentialVault({ buddyHome, cipher: { ...reversibleCipher, available: () => available } })
    const directory = join(buddyHome, 'secrets', 'providers')
    const digest = (id: string) => createHash('sha256').update(id).digest('hex')
    const path = (id: string) => join(directory, `${digest(id)}.credential`)
    await vault.write('providers', 'subscription', { type: 'oauth', access: 'synthetic', refresh: 'synthetic', expires: 1 })
    await vault.write('providers', 'legacy', { type: 'api_key', key: 'synthetic-key' })
    const original = await readFile(path('legacy'))
    const oldBytes = Buffer.from('fixture-unreadable')
    await writeFile(path('legacy'), oldBytes)
    await writeFile(path('misplaced'), await readFile(path('subscription')))
    await writeFile(join(directory, 'fixture-private-name.credential'), oldBytes)
    await vault.write('providers', 'invalid', { type: 'oauth' })
    const files = (await readdir(directory)).sort()
    const inventory = await vault.scanProviders()
    expect(inventory).toEqual({ providers: [{ providerId: 'subscription', type: 'oauth' }], unreadableProviderDigests: ['legacy', 'misplaced', 'invalid'].map(digest).sort() })
    expect(JSON.stringify(inventory)).not.toMatch(/fixture-private|synthetic/)
    expect(await readFile(path('legacy'))).toEqual(oldBytes)
    expect((await readdir(directory)).sort()).toEqual(files)
    await expect(vault.listProviders()).rejects.toBeInstanceOf(CredentialVaultError)
    await expect(exportBackupCredentials(buddyHome, ['providers'])).rejects.toThrow()
    available = false
    await expect(vault.scanProviders()).rejects.toBeInstanceOf(CredentialStoreUnavailableError)
    available = true
    await writeFile(path('legacy'), original)
    expect((await vault.scanProviders()).providers).toEqual([{ providerId: 'legacy', type: 'api_key' }, { providerId: 'subscription', type: 'oauth' }])
  })

  it('keeps provider and connector namespaces isolated', async () => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const vault = createCredentialVault({ buddyHome, cipher: reversibleCipher })

    await vault.write('providers', 'shared-id', { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1 })
    await vault.write('connectors', 'shared-id', { bearer: 'connector-secret' })

    await expect(vault.read('providers', 'shared-id')).resolves.toMatchObject({ type: 'oauth' })
    await expect(vault.read('connectors', 'shared-id')).resolves.toEqual({ bearer: 'connector-secret' })
    await vault.delete('providers', 'shared-id')
    await expect(vault.read('providers', 'shared-id')).resolves.toBeNull()
    await expect(vault.read('connectors', 'shared-id')).resolves.toEqual({ bearer: 'connector-secret' })
  })

  it('never falls back to plaintext when host encryption is unavailable', async () => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const vault = createCredentialVault({
      buddyHome,
      cipher: {
        ...reversibleCipher,
        available: () => false,
      },
    })

    await expect(vault.write('providers', 'anthropic', {
      type: 'api_key',
      key: 'sk-test-secret',
    })).rejects.toBeInstanceOf(CredentialStoreUnavailableError)
    await expect(readdir(join(buddyHome, 'secrets', 'providers'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['linux', 'basic_text', true, false],
    ['linux', 'gnome_libsecret', true, true],
    ['linux', 'kwallet6', true, true],
    ['win32', 'unknown', true, true],
    ['win32', 'unknown', false, false],
  ] as const)('checks host encryption on %s with backend %s and availability %s', (platform, backend, encryptionAvailable, secure) => {
    expect(isSafeStorageBackendSecure({ backend, encryptionAvailable, platform })).toBe(secure)
  })

  const failingDecrypts: ReadonlyArray<readonly [string, SecretCipher['decrypt'], string]> = [
    ['decrypt', () => { throw new Error('fixture-private-credential') }, 'operation_failed'],
    ['parse', () => '{"key":"fixture-private-credential"', 'operation_failed'],
    ['validate', () => JSON.stringify({ version: 1, id: 'other', value: { type: 'api_key', key: 'fixture-private-credential' } }), 'identifier_mismatch'],
    ['validate', () => '[]', 'invalid_envelope'],
    ['validate', () => JSON.stringify({ version: 1, id: '', value: { type: 'api_key', key: 'fixture-private-credential' } }), 'invalid_envelope'],
    ['validate', () => JSON.stringify({ version: 2, id: 'fixture', value: 'fixture-private-credential' }), 'unsupported_version'],
  ]

  it.each(failingDecrypts)('reports the %s phase without keeping credential text', async (phase, decrypt, reason) => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const events: ApplicationDiagnostic[] = []
    const vault = createCredentialVault({ buddyHome, cipher: { ...reversibleCipher, decrypt }, reportDiagnostic: event => events.push(event) })
    await vault.write('providers', 'fixture', { type: 'api_key', key: 'fixture-private-credential' })

    const error = await vault.read('providers', 'fixture').catch((value: unknown) => value)
    expect(error).toBeInstanceOf(CredentialVaultError)
    expect(error).toMatchObject({ phase, reason })
    expect(events).toEqual([expect.objectContaining({ failure: { kind: 'credential_vault', operation: 'read', namespace: 'providers', phase, reason } })])
    expect(JSON.stringify({ ...(error as object), message: (error as Error).message, cause: (error as Error).cause })).not.toContain('fixture-private-credential')
  })

  it('keeps the system error code when a credential file cannot be read', async () => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const events: ApplicationDiagnostic[] = []
    const vault = createCredentialVault({ buddyHome, cipher: reversibleCipher, reportDiagnostic: event => events.push(event) })
    await vault.write('providers', 'fixture', { type: 'api_key', key: 'fixture-private-credential' })
    const blocked = join(buddyHome, 'secrets', 'providers', 'blocked.credential')
    await mkdir(blocked)
    await writeFile(join(blocked, 'placeholder'), '')

    await expect(vault.listProviders()).rejects.toMatchObject({ phase: 'read_file', systemCode: 'EISDIR' })
    expect(events).toEqual([expect.objectContaining({ errorCode: 'CREDENTIAL_STORE_FAILURE', failure: { kind: 'credential_vault', operation: 'list', namespace: 'providers', phase: 'read_file', reason: 'operation_failed', systemCode: 'EISDIR' } })])
  })

  it.each([
    { available: false, code: 'CREDENTIAL_STORE_UNAVAILABLE', phase: 'availability', reason: 'unavailable' },
    { available: true, code: 'CREDENTIAL_STORE_FAILURE', phase: 'encrypt', reason: 'operation_failed' },
  ])('returns only a safe RPC error when encryption fails: $code', async ({ available, code, phase, reason }) => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const secret = 'fixture-private-credential'
    const failures: ApplicationDiagnostic[] = []
    const vault = createCredentialVault({
      buddyHome,
      reportDiagnostic: event => failures.push(event),
      cipher: {
        ...reversibleCipher,
        available: () => available,
        encrypt: (value) => { throw new Error(`cipher rejected ${value}`) },
      },
    })
    const incoming = new EventEmitter()
    const responses: unknown[] = []
    const peer = new RuntimeRpcPeer({
      transport: {
        postMessage: message => responses.push(message),
        subscribe(listener) {
          incoming.on('message', listener)
          return () => {
            incoming.off('message', listener)
          }
        },
      },
    })
    const dispose = registerCredentialHostRpc(peer, vault)
    try {
      incoming.emit('message', {
        jsonrpc: '2.0',
        id: 'credential-write',
        method: 'host.credentials.write',
        params: { providerId: 'fixture', credential: { type: 'api_key', key: secret } },
      })
      await vi.waitFor(() => expect(responses).toEqual([{
        jsonrpc: '2.0',
        id: 'credential-write',
        result: { ok: false, error: { code } },
      }]))
      expect(await readdir(join(buddyHome, 'secrets', 'providers')).catch(() => [])).toEqual([])
      expect(failures).toEqual([{ event: `credential.${phase}.failed`, component: 'desktop.credentials', level: 'warn', errorCode: code, failure: { kind: 'credential_vault', operation: 'write', namespace: 'providers', phase, reason } }])
      expect(JSON.stringify(failures)).not.toContain(secret)
    }
    finally {
      dispose()
      peer.close(new Error('test completed'))
    }
  })

  it.each(['web', 'sync', 'backup'] as const)('exports safe diagnostics for direct %s failures without accepting arbitrary error fields', async (namespace) => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const directory = join(buddyHome, 'logs')
    const logger = new DesktopDiagnosticLogger({ directory, appVersion: '0.13.0', userHome: '/fixture' })
    const vault = createCredentialVault({
      buddyHome,
      cipher: { ...reversibleCipher, encrypt: () => { throw Object.assign(new Error('fixture-private-message'), { name: 'FixturePrivateCredential', code: 'FIXTURE_PRIVATE_CREDENTIAL' }) } },
      reportDiagnostic: event => expect(logger.record({ ...event, scope: 'desktop' })).toBe(true),
    })
    await expect(vault.write(namespace, 'fixture-private-id', 'fixture-private-value')).rejects.toMatchObject({ phase: 'encrypt' })
    await logger.close()
    const reader = new ApplicationLogReader(directory, logger.launchId, '/fixture')
    const page = await reader.query({})
    expect(page.skippedRecords).toBe(0)
    expect(page.records).toHaveLength(1)
    const failure = { kind: 'credential_vault', operation: 'write', namespace, phase: 'encrypt', reason: 'operation_failed' }
    expect(page.records[0]).toMatchObject({ errorCode: 'CREDENTIAL_STORE_FAILURE', failure })
    const bundle = await createApplicationDiagnosticBundle(reader, 'current')
    expect(bundle).not.toBeNull()
    const files = unzipSync(bundle!.bytes)
    const records = strFromU8(files['context.jsonl']!).trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual([expect.objectContaining({ failure })])
    expect(JSON.stringify({ page, records })).not.toMatch(/fixture-private|FixturePrivate|FIXTURE_PRIVATE/)
  })

  it('keeps an invalid native error name from suppressing the failure record', async () => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const logger = new DesktopDiagnosticLogger({ directory: join(buddyHome, 'logs'), appVersion: '0.13.0', userHome: '/fixture' })
    const vault = createCredentialVault({
      buddyHome,
      cipher: { ...reversibleCipher, available: () => { throw Object.assign(new Error('fixture-private'), { name: 'Cipher Error' }) } },
      reportDiagnostic: event => expect(logger.record({ ...event, scope: 'desktop' })).toBe(true),
    })
    await expect(vault.read('web', 'fixture')).rejects.toMatchObject({ phase: 'availability' })
    expect((await logger.close()).written).toBe(1)
  })

  it('preserves the stored credential and original failure when diagnostic reporting throws', async () => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const vault = createCredentialVault({ buddyHome, cipher: reversibleCipher })
    await vault.write('providers', 'fixture', { type: 'api_key', key: 'previous-synthetic' })
    const failing = createCredentialVault({
      buddyHome,
      cipher: { ...reversibleCipher, encrypt: () => { throw new Error('cipher failed') } },
      reportDiagnostic: () => { throw new Error('logger failed') },
    })
    await expect(failing.write('providers', 'fixture', { type: 'api_key', key: 'next-synthetic' })).rejects.toMatchObject({ phase: 'encrypt' })
    expect(await vault.read('providers', 'fixture')).toEqual({ type: 'api_key', key: 'previous-synthetic' })
    expect(await readdir(join(buddyHome, 'secrets', 'providers'))).toHaveLength(1)
  })

  it('treats absent entries as normal and reports invalid provider types once', async () => {
    const buddyHome = await createTemporaryDirectory('lexora-buddy-vault-')
    const events: ApplicationDiagnostic[] = []
    const vault = createCredentialVault({ buddyHome, cipher: reversibleCipher, reportDiagnostic: event => events.push(event) })
    expect(await vault.listProviders()).toEqual([])
    expect(await vault.read('providers', 'absent')).toBeNull()
    await vault.delete('providers', 'absent')
    expect(events).toEqual([])
    await vault.write('providers', 'fixture', { type: 'fixture-private' })
    await expect(vault.listProviders()).rejects.toMatchObject({ phase: 'validate', reason: 'invalid_credential_type' })
    expect(events).toEqual([expect.objectContaining({ failure: { kind: 'credential_vault', operation: 'list', namespace: 'providers', phase: 'validate', reason: 'invalid_credential_type' } })])
  })

  it('only lets the Electron host open HTTPS and loopback callback URLs', () => {
    expect(isAllowedExternalUrl('https://auth.openai.com/authorize')).toBe(true)
    expect(isAllowedExternalUrl('http://127.0.0.1:1455/callback')).toBe(true)
    expect(isAllowedExternalUrl('http://localhost:1455/callback')).toBe(true)
    expect(isAllowedExternalUrl('http://auth.example.test/authorize')).toBe(false)
    expect(isAllowedExternalUrl('file:///tmp/credential')).toBe(false)
    expect(isAllowedExternalUrl('not-a-url')).toBe(false)
  })
})
