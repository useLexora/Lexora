import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PRIVATE_NETWORK_LIMITS } from '../../../../shared/privateNetwork/limits'
import { deviceBearer } from '../../../../shared/privateNetwork/pairing'
import { CommandAdmissionService } from '../../commands/CommandAdmissionService'
import { ProductConnection } from '../../productProtocol/ProductConnection'
import { ProductQueries } from '../../productProtocol/ProductQueries'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { DeviceAuthorizationService } from '../DeviceAuthorizationService'

const directories: string[] = []
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-device-auth-'))
  directories.push(directory)
  const path = join(directory, 'buddy.sqlite3')
  const database = openBuddyMigrationCandidate({ databasePath: path })
  databases.push(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  let time = Date.parse('2026-11-07T00:00:00.000Z')
  const clock = () => time
  const auth = new DeviceAuthorizationService({ database, serviceId: 'service', profileId: 'profile', serviceInstanceId: 'instance', clock })
  const offer = () => {
    const qr = auth.issue('https://127.0.0.1:9443', `sha256/${'A'.repeat(43)}=`)
    const { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret } = qr
    return { serviceId, profileId, issuerInstanceId, ticketId, ticketSecret }
  }
  const pair = () => {
    const context = offer()
    const recovery = auth.prepare({ ...context, deviceName: '隔离测试手机' })
    const credential = auth.redeem({ ...context, attemptId: recovery.attemptId, recoverySecret: recovery.recoverySecret })
    return { context, recovery, credential, bearer: deviceBearer(credential) }
  }
  return { database, path, auth, offer, pair, clock, advance: (ms: number) => time += ms }
}

describe('durable device authorization', () => {
  it('keeps task and message pagination valid across authenticated requests and authorization sweeps', async () => {
    const f = fixture()
    const conversations = createConversationRepository(f.database)
    for (const id of ['first', 'second']) {
      conversations.create({ id, branchId: `branch-${id}`, title: id, spaceId: null, createdAt: '2026-01-01T00:00:00.000Z', approvalPolicy: 'policy', executionProfile: 'workspace_write' })
      for (let index = 0; index < 3; index++)
        conversations.createMessage({ id: `${id}-${index}`, conversationId: id, branchId: `branch-${id}`, runId: null, role: 'user', content: `message ${index}`, createdAt: `2026-01-01T00:00:0${index}.000Z` })
    }
    const paired = f.pair()
    f.auth.confirm(paired.bearer)
    const identity = f.auth.authenticate(paired.bearer)
    const frames: any[] = []
    const connection = new ProductConnection({
      context: f.auth.context(identity),
      assertCurrent: () => f.auth.assertCurrent(identity),
      phase: () => 'ready',
      handlers: new ProductQueries(f.database, identity.deviceId, 'instance').handlers(),
      send: (raw) => {
        frames.push(JSON.parse(raw))
        return true
      },
      close() {},
    })
    const request = async (method: string, params: unknown) => {
      await connection.receive(JSON.stringify({ jsonrpc: '2.0', id: String(frames.length), method, params }))
      const response = frames.at(-1)
      expect(response.error).toBeUndefined()
      return response.result
    }
    try {
      await request('initialize', { protocol: { major: 1, minMinor: 0, maxMinor: 0 }, client: { kind: 'mobile', version: '1' }, supportedContentKinds: ['buddy-user-content-v1'], supportedReviewKinds: [] })
      const tasks = await request('conversations.list', { limit: 1, cursor: null })
      const input = { conversationId: 'first', branchId: 'branch-first', limit: 1, cursor: null }
      const messages = await request('conversations.listMessages', input)
      expect(tasks.nextCursor).toEqual(expect.any(String))
      expect(messages.nextCursor).toEqual(expect.any(String))
      f.advance(1000)
      f.auth.sweep()
      f.advance(10)
      expect(await request('conversations.list', { limit: 1, cursor: tasks.nextCursor })).toMatchObject({ items: [{ id: 'second' }], nextCursor: null })
      f.advance(10)
      expect(await request('conversations.listMessages', { ...input, cursor: messages.nextCursor })).toMatchObject({ items: [{ id: 'first-1' }] })
      f.database.prepare('UPDATE messages SET content_json = ? WHERE id = ?').run(JSON.stringify('changed'), 'first-1')
      await connection.receive(JSON.stringify({ jsonrpc: '2.0', id: 'changed-history', method: 'conversations.listMessages', params: { ...input, cursor: messages.nextCursor } }))
      expect(frames.at(-1)).toMatchObject({ error: { code: 'CURSOR_EXPIRED' } })
    }
    finally { connection.close() }
  })

  it('consumes one ticket for one device and only the original recovery proof can recover it', () => {
    const f = fixture()
    const context = f.offer()
    const a = f.auth.prepare({ ...context, deviceName: 'A' })
    const b = f.auth.prepare({ ...context, deviceName: 'B' })
    const first = f.auth.redeem({ ...context, attemptId: a.attemptId, recoverySecret: a.recoverySecret })
    expect(() => f.auth.authenticate(deviceBearer(first))).toThrow('NOT_AUTHORIZED')
    expect(() => f.auth.redeem({ ...context, attemptId: b.attemptId, recoverySecret: b.recoverySecret })).toThrow('PAIRING_USED')
    expect(() => f.auth.redeem({ ...context, attemptId: a.attemptId, recoverySecret: a.recoverySecret })).toThrow('RECOVERY_REQUIRED')
    const sibling = f.auth.recover({ serviceId: 'service', profileId: 'profile', attemptId: a.attemptId, recoverySecret: a.recoverySecret })
    expect(sibling.deviceId).toBe(first.deviceId)
    expect(f.auth.confirm(deviceBearer(first)).state).toBe('active')
    expect(f.auth.confirm(deviceBearer(first)).state).toBe('active')
    expect(f.auth.authenticate(deviceBearer(sibling)).deviceId).toBe(first.deviceId)
    expect(() => f.auth.recover({ serviceId: 'service', profileId: 'profile', attemptId: a.attemptId, recoverySecret: a.recoverySecret })).toThrow('RECOVERY_CLOSED')
    const rows = JSON.stringify(['pairing_tickets', 'pairing_attempts', 'remote_credentials'].map(table => f.database.prepare(`SELECT * FROM ${table}`).all()))
    for (const secret of [context.ticketSecret, a.recoverySecret, first.credentialSecret, sibling.credentialSecret]) expect(rows).not.toContain(secret)
    expect(f.auth.list()).toHaveLength(1)
  })

  it('keeps a consumed attempt across restart but invalidates old unconsumed QR and bounds siblings', () => {
    const f = fixture()
    const paired = f.pair()
    const pending = f.offer()
    const next = new DeviceAuthorizationService({ database: f.database, serviceId: 'service', profileId: 'profile', serviceInstanceId: 'next', clock: f.clock })
    expect(() => next.prepare({ ...pending, deviceName: 'late' })).toThrow('PAIRING_UNAVAILABLE')
    for (let index = 1; index < PRIVATE_NETWORK_LIMITS.siblingCredentials; index++) next.recover({ serviceId: 'service', profileId: 'profile', attemptId: paired.recovery.attemptId, recoverySecret: paired.recovery.recoverySecret })
    expect(() => next.recover({ serviceId: 'service', profileId: 'profile', attemptId: paired.recovery.attemptId, recoverySecret: paired.recovery.recoverySecret })).toThrow('LIMIT_EXCEEDED')
    next.confirm(paired.bearer)
    expect(next.authenticate(paired.bearer).deviceId).toBe(paired.credential.deviceId)
  })

  it('rolls back the ticket, device and attempt if credential persistence fails', () => {
    const f = fixture()
    const context = f.offer()
    const attempt = f.auth.prepare({ ...context, deviceName: 'failure' })
    f.database.exec('CREATE TRIGGER credential_fault BEFORE INSERT ON remote_credentials BEGIN SELECT RAISE(ABORT, \'fixture fault\'); END')
    const input = { ...context, attemptId: attempt.attemptId, recoverySecret: attempt.recoverySecret }
    expect(() => f.auth.redeem(input)).toThrow('fixture fault')
    expect(f.auth.list()).toHaveLength(0)
    expect(f.database.prepare('SELECT state FROM pairing_tickets').get()!.state).toBe('pending')
    expect(f.database.prepare('SELECT device_id FROM pairing_attempts').get()!.device_id).toBeNull()
    f.database.exec('DROP TRIGGER credential_fault')
    expect(f.auth.redeem(input).deviceId).toBeTruthy()
  })

  it('commits revocation before closing transports and rejects an asynchronously prepared command at commit', async () => {
    const f = fixture()
    const pair = f.pair()
    f.auth.confirm(pair.bearer)
    const identity = f.auth.authenticate(pair.bearer)
    const admission = new CommandAdmissionService({ database: f.database, principal: f.auth.principal(identity), sourceInstanceId: 'instance' })
    let finish!: () => void
    let started!: () => void
    const prepared = new Promise<void>(resolve => started = resolve)
    const pending = admission.execute('composerDrafts.discard', { dataGeneration: identity.dataGeneration, commandId: 'blocked', expectedServiceInstanceId: 'instance', intent: { draftId: 'draft', expectedRevision: 0 } }, { prepare: async () => {
      started()
      await new Promise<void>(resolve => finish = resolve)
    }, commit: () => ({ target: {}, result: {} }) })
    const rejected = expect(pending).rejects.toThrow('COMMAND_ACTOR_UNAVAILABLE')
    await prepared
    let observed = false
    f.auth.onDidInvalidate(({ deviceId }) => {
      expect(deviceId).toBe(identity.deviceId)
      expect(f.database.isTransaction).toBe(false)
      expect(() => f.auth.authenticate(pair.bearer)).toThrow('NOT_AUTHORIZED')
      observed = true
    })
    f.auth.revoke(identity.deviceId)
    finish()
    await rejected
    expect(observed).toBe(true)
    expect(f.database.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n).toBe(0)
    expect(() => f.database.prepare('UPDATE remote_devices SET state = \'active\' WHERE id = ?').run(identity.deviceId)).toThrow('DEVICE_STATE_TERMINAL')
  })

  it('does not revive expired credentials after wall-clock rollback, restart or renewal', () => {
    const f = fixture()
    const paired = f.pair()
    f.auth.confirm(paired.bearer)
    f.advance(PRIVATE_NETWORK_LIMITS.credentialIdleMs + 1)
    expect(() => f.auth.renew(paired.bearer)).toThrow('NOT_AUTHORIZED')
    f.advance(-PRIVATE_NETWORK_LIMITS.credentialIdleMs)
    f.database.close()
    const reopened = openBuddyMigrationCandidate({ databasePath: f.path })
    databases.push(reopened)
    const next = new DeviceAuthorizationService({ database: reopened, serviceId: 'service', profileId: 'profile', serviceInstanceId: 'next', clock: f.clock })
    expect(() => next.authenticate(paired.bearer)).toThrow('NOT_AUTHORIZED')
    expect(next.list()[0]?.state).toBe('expired')
  })
})
