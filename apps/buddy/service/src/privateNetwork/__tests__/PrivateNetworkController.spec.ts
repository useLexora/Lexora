import { X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBuddyMigrationCandidate } from '../../storage/database'
import * as addresses from '../privateNetworkAddress'
import { PrivateNetworkController } from '../PrivateNetworkController'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  vi.restoreAllMocks()
})
function fixture(legacy?: { address: string, port: number }) {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-network-controller-'))
  const database = openBuddyMigrationCandidate({ databasePath: join(directory, 'buddy.sqlite3') })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  if (legacy)
    database.prepare('UPDATE private_network_state SET enabled = 1, bind_address = ?, port = ?').run(legacy.address, legacy.port)
  let stored: unknown = null
  const controller = new PrivateNetworkController({
    database,
    serviceId: 'service',
    profileId: 'profile',
    serviceInstanceId: 'instance',
    secrets: {
      read: async () => stored,
      write: async (_, value) => { stored = structuredClone(value) },
    },
    connect: () => { throw new Error('Unexpected product connection') },
  })
  cleanup.push(async () => {
    await controller.close()
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { controller, database }
}
async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}
function connectionInfo(endpoint: string) {
  return new Promise<number>((resolve, reject) => {
    const req = request(`${endpoint}/v1/connection-info`, { rejectUnauthorized: false }, (response) => {
      const certificate = new X509Certificate((response.socket as import('node:tls').TLSSocket).getPeerCertificate().raw)
      if (!certificate.checkIP(new URL(endpoint).hostname.replace(/^\[|\]$/g, ''))) {
        reject(new Error('Certificate does not cover the listener'))
        return
      }
      response.resume()
      resolve(response.statusCode!)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('mobile connection configuration', () => {
  it('starts without a supplied address and keeps its TLS identity after disabling and reenabling', async () => {
    vi.spyOn(addresses, 'selectPrivateNetworkAddresses').mockReturnValue(['127.0.0.1'])
    const { controller } = fixture()
    const port = await freePort()
    const listening = await controller.configure({ enabled: true, port })
    expect(listening).toMatchObject({ enabled: true, state: 'listening', bindAddress: null, endpoint: `https://127.0.0.1:${port}`, errorCode: null })
    expect(listening.spkiPin).toMatch(/^sha256\//)
    expect(await controller.configure({ enabled: false })).toMatchObject({ enabled: false, state: 'disabled', endpoint: null })
    expect(await controller.configure({ enabled: true })).toMatchObject({ state: 'listening', spkiPin: listening.spkiPin, port })
    await expect(controller.configure({ enabled: true, bindAddress: '0.0.0.0' })).rejects.toThrow('INVALID_REQUEST')
    expect(controller.status()).toMatchObject({ state: 'listening', spkiPin: listening.spkiPin })
  })
  it('preserves explicit bindings and keeps the existing certificate identity when switching to automatic addresses', async () => {
    vi.spyOn(addresses, 'selectPrivateNetworkAddresses').mockReturnValue(['127.0.0.1', '::1'])
    const { controller } = fixture()
    const port = await freePort()
    const first = await controller.configure({ enabled: true, bindAddress: '127.0.0.1', port })
    const lan = `https://127.0.0.1:${port}`
    const vpn = `https://[::1]:${port}`
    await expect(connectionInfo(lan)).resolves.toBe(200)
    await expect(connectionInfo(vpn)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(await controller.configure({ enabled: true, bindAddress: '' })).toMatchObject({ bindAddress: null, endpoint: lan, spkiPin: first.spkiPin })
    await expect(connectionInfo(vpn)).resolves.toBe(200)
    await expect(connectionInfo(lan)).resolves.toBe(200)
  })

  it('restores a legacy saved address as an automatic preference and preserves its port', async () => {
    const selection = vi.spyOn(addresses, 'selectPrivateNetworkAddresses').mockReturnValue(['127.0.0.1', '::1'])
    const port = await freePort()
    const { controller } = fixture({ address: '127.0.0.1', port })
    await controller.restore()
    expect(selection).toHaveBeenCalledWith(undefined, '127.0.0.1')
    expect(controller.status()).toMatchObject({ state: 'listening', bindAddress: null, port })
    await expect(connectionInfo(`https://127.0.0.1:${port}`)).resolves.toBe(200)
    await expect(connectionInfo(`https://[::1]:${port}`)).resolves.toBe(200)
  })

  it('reports missing networks without opening a listener and can retry when a private network appears', async () => {
    const selection = vi.spyOn(addresses, 'selectPrivateNetworkAddresses').mockReturnValue([])
    const { controller } = fixture()
    expect(await controller.configure({ enabled: true })).toMatchObject({ state: 'unavailable', bindAddress: null, port: 19443, endpoint: null, errorCode: 'ADDRESS_UNAVAILABLE' })
    expect(controller.auth.list()).toEqual([])
    await controller.configure({ enabled: false })
    selection.mockReturnValue(['127.0.0.1'])
    expect(await controller.configure({ enabled: true, port: await freePort() })).toMatchObject({ state: 'listening', errorCode: null })
  })
})
