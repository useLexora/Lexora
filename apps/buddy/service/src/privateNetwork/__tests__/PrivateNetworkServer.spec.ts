import type { DatabaseSync } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkServerIdentity } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { deviceBearer } from '../../../../shared/privateNetwork/pairing'
import { ProductConnection } from '../../productProtocol/ProductConnection'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { DeviceAuthorizationService } from '../DeviceAuthorizationService'
import { PrivateNetworkServer } from '../PrivateNetworkServer'
import { isPrivateNetworkAddress, loadPrivateNetworkTlsIdentity } from '../PrivateNetworkTlsIdentity'

const directories: string[] = []
const databases: DatabaseSync[] = []
const servers: PrivateNetworkServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-private-network-'))
  directories.push(directory)
  const database = openBuddyMigrationCandidate({ databasePath: join(directory, 'buddy.sqlite3') })
  databases.push(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  let stored: unknown | null = null
  const secrets = { read: async () => stored, write: async (_id: string, value: unknown) => {
    stored = structuredClone(value)
  } }
  const tls = await loadPrivateNetworkTlsIdentity({ database, profileId: 'profile', secrets, addresses: ['127.0.0.1'] })
  const auth = new DeviceAuthorizationService({ database, serviceId: 'service', profileId: 'profile', serviceInstanceId: 'instance' })
  const server = new PrivateNetworkServer({ auth, identity: { serviceId: 'service', profileId: 'profile' }, tls, connect: (identity, transport) => new ProductConnection({ ...transport, context: auth.context(identity), assertCurrent: () => auth.assertCurrent(identity), phase: () => 'ready', handlers: { 'conversations.list': { handle: () => ({ items: [], nextCursor: null }) } } }) })
  servers.push(server)
  const endpoint = await server.listen('127.0.0.1', 0)
  const call = (path: string, body?: unknown, bearer?: string, pin = tls.spkiPin) => new Promise<{ status: number, body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(`${endpoint}${path}`, { method: payload === undefined ? 'GET' : 'POST', ca: tls.certificate, checkServerIdentity: (host, cert) => {
      const failure = checkServerIdentity(host, cert)
      if (failure)
        return failure
      const actual = `sha256/${createHash('sha256').update(new X509Certificate(cert.raw).publicKey.export({ format: 'der', type: 'spki' })).digest('base64')}`
      return actual === pin ? undefined : new Error('PIN_MISMATCH')
    }, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } }, (response) => {
      let value = ''
      response.setEncoding('utf8')
      response.on('data', chunk => value += chunk)
      response.on('end', () => resolve({ status: response.statusCode!, body: value ? JSON.parse(value) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
  return { database, secrets, tls, auth, server, endpoint, call }
}

describe('private TLS transport', () => {
  it('reuses its protected key across certificates and rejects missing keys or public bindings', async () => {
    const f = await fixture()
    const renewed = await loadPrivateNetworkTlsIdentity({ database: f.database, profileId: 'profile', secrets: f.secrets, addresses: ['127.0.0.1', '::1'] })
    expect(renewed.spkiPin).toBe(f.tls.spkiPin)
    expect(new X509Certificate(renewed.certificate).checkIP('::1')).toBe('::1')
    await f.secrets.write('', null)
    await expect(loadPrivateNetworkTlsIdentity({ database: f.database, profileId: 'profile', secrets: f.secrets, addresses: ['127.0.0.1'] })).rejects.toThrow('TLS_IDENTITY_UNAVAILABLE')
    expect(['0.0.0.0', '::', '8.8.8.8', 'example.com', '127.0.0.1.example.com'].map(isPrivateNetworkAddress)).toEqual([false, false, false, false, false])
    expect(['127.0.0.1', '10.0.0.2', '192.168.1.2', '100.100.1.1', '::1', 'fd00::1'].every(isPrivateNetworkAddress)).toBe(true)
  })

  it('uses one authenticated HTTPS/WSS identity, activates only after confirm and closes revoked connections', async () => {
    const f = await fixture()
    const qr = f.auth.issue(f.endpoint, f.tls.spkiPin)
    const { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret } = qr
    const context = { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret }
    await expect(f.call('/v1/pairing/prepare', { ...context, deviceName: 'Wrong pin' }, undefined, `sha256/${'B'.repeat(43)}=`)).rejects.toThrow('PIN_MISMATCH')
    expect(f.database.prepare('SELECT count(*) AS n FROM pairing_attempts').get()!.n).toBe(0)
    expect((await f.call('/v1/pairing/redeem')).status).toBe(400)
    const prepared = await f.call('/v1/pairing/prepare', { ...context, deviceName: 'Native fixture' })
    expect(prepared.status).toBe(200)
    const redeemed = await f.call('/v1/pairing/redeem', { ...context, attemptId: prepared.body.attemptId, recoverySecret: prepared.body.recoverySecret })
    const bearer = deviceBearer(redeemed.body)
    expect((await f.call('/v1/device', undefined, bearer)).status).toBe(401)
    expect((await f.call('/v1/pairing/confirm', {}, bearer)).body.state).toBe('active')
    const socket = new WebSocket(`${f.endpoint.replace('https:', 'wss:')}/v1/rpc`, { ca: f.tls.certificate, headers: { Authorization: `Bearer ${bearer}` } })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const receive = () => new Promise<any>((resolve, reject) => {
      socket.once('message', data => resolve(JSON.parse(data.toString())))
      socket.once('error', reject)
    })
    let response = receive()
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'before', method: 'conversations.list', params: {} }))
    expect(await response).toMatchObject({ error: { code: 'NOT_INITIALIZED' } })
    response = receive()
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocol: { major: 1, minMinor: 0, maxMinor: 0 }, client: { kind: 'desktop', version: 'fixture' }, supportedContentKinds: [], supportedReviewKinds: [] } }))
    expect(await response).toMatchObject({ result: { deviceId: redeemed.body.deviceId, profileId: 'profile' } })
    response = receive()
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'conversations.list', params: {} }))
    expect(await response).toMatchObject({ result: { items: [], nextCursor: null } })
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    f.auth.revoke(redeemed.body.deviceId)
    await closed
    expect((await f.call('/v1/device', undefined, bearer)).status).toBe(401)
    expect((await f.call('/v1/device?token=forbidden', undefined, bearer)).status).toBe(400)
  })
})
