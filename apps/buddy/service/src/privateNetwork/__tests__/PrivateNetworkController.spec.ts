import { mkdtempSync, rmSync } from 'node:fs'
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
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-network-controller-'))
  const database = openBuddyMigrationCandidate({ databasePath: join(directory, 'buddy.sqlite3') })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
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
  return controller
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
describe('mobile connection configuration', () => {
  it('starts without a supplied address and keeps its TLS identity after disabling and reenabling', async () => {
    vi.spyOn(addresses, 'selectPrivateNetworkAddress').mockReturnValue('127.0.0.1')
    const controller = fixture()
    const port = await freePort()
    const listening = await controller.configure({ enabled: true, port })
    expect(listening).toMatchObject({ enabled: true, state: 'listening', bindAddress: '127.0.0.1', endpoint: `https://127.0.0.1:${port}`, errorCode: null })
    expect(listening.spkiPin).toMatch(/^sha256\//)
    expect(await controller.configure({ enabled: false })).toMatchObject({ enabled: false, state: 'disabled', endpoint: null })
    expect(await controller.configure({ enabled: true })).toMatchObject({ state: 'listening', spkiPin: listening.spkiPin, port })
    await expect(controller.configure({ enabled: true, bindAddress: '0.0.0.0' })).rejects.toThrow('INVALID_REQUEST')
    expect(controller.status()).toMatchObject({ state: 'listening', spkiPin: listening.spkiPin })
  })
  it('reports missing networks without opening a listener and can retry when a private network appears', async () => {
    const selection = vi.spyOn(addresses, 'selectPrivateNetworkAddress').mockReturnValue(null)
    const controller = fixture()
    expect(await controller.configure({ enabled: true })).toMatchObject({ state: 'unavailable', bindAddress: null, port: 19443, endpoint: null, errorCode: 'ADDRESS_UNAVAILABLE' })
    expect(controller.auth.list()).toEqual([])
    await controller.configure({ enabled: false })
    selection.mockReturnValue('127.0.0.1')
    expect(await controller.configure({ enabled: true, port: await freePort() })).toMatchObject({ state: 'listening', errorCode: null })
  })
})
