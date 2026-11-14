import type { DatabaseSync } from 'node:sqlite'
import type { TrustedCommandPrincipal } from '../CommandAdmissionService'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandCommitter } from '../../storage/CommandCommitter'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { guardStorageDatabase } from '../../storage/StorageIsolation'
import { CommandAdmissionError } from '../CommandAdmissionError'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../CommandAdmissionService'

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) {
    if (database.isOpen)
      database.close()
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function fixture(file = false) {
  const directory = file ? mkdtempSync(join(tmpdir(), 'lexora-command-admission-')) : null
  if (directory)
    directories.push(directory)
  const databasePath = directory ? join(directory, 'candidate.sqlite3') : ':memory:'
  const database = openBuddyMigrationCandidate({ databasePath })
  databases.push(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'; CREATE TABLE effects (id TEXT PRIMARY KEY) STRICT')
  const dataGeneration = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
  const principal = createLocalCommandPrincipal(database)
  const createService = (sourceInstanceId = 'instance-1', actor: TrustedCommandPrincipal = principal) => new CommandAdmissionService({ database, principal: actor, sourceInstanceId })
  const service = createService()
  const submission = { dataGeneration, commandId: 'command-1', expectedServiceInstanceId: 'instance-1', intent: { draftId: 'draft-1', expectedRevision: 2 } }
  const identity = { dataGeneration, commandId: 'command-1' }
  const commit = () => {
    database.prepare('INSERT INTO effects VALUES (?)').run('original-effect')
    return { target: { runId: 'original-run' }, result: { acceptedRevision: 3 } }
  }
  return { database, databasePath, dataGeneration, principal, service, createService, submission, identity, commit }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('trusted command admission', () => {
  it('looks up immutable original decisions before stale drafts, restart instance checks and stopping', async () => {
    const f = fixture()
    const accepted = await f.service.execute('chat.startTurn', f.submission, { prepare: async () => {}, commit: f.commit })
    f.database.exec('DELETE FROM effects')
    const restarted = f.createService('instance-2')
    restarted.stopAccepting()
    const duplicate = await restarted.execute('chat.startTurn', f.submission, { prepare: async () => {
      throw new Error('draft was deleted')
    }, commit: f.commit })
    expect(duplicate).toEqual({ created: false, receipt: accepted.receipt })
    expect(f.service.lookup(f.identity)).toEqual({ lookup: 'decided', receipt: accepted.receipt })
    await expect(restarted.execute('chat.startTurn', { ...f.submission, commandId: 'absent' }, { prepare: async () => {}, commit: f.commit })).rejects.toMatchObject({ code: 'SERVICE_STOPPING' })
    await expect(f.createService('instance-2').execute('chat.startTurn', { ...f.submission, commandId: 'absent' }, { prepare: async () => {}, commit: f.commit })).rejects.toMatchObject({ code: 'SERVICE_INSTANCE_CHANGED' })
  })

  it('reports only live preparation as pending and coalesces identical attempts', async () => {
    const f = fixture()
    const gate = deferred()
    expect(f.service.lookup(f.identity)).toEqual({ lookup: 'not_found' })
    const first = f.service.execute('chat.startTurn', f.submission, { prepare: async () => gate.promise, commit: f.commit })
    expect(f.service.lookup(f.identity)).toEqual({ lookup: 'pending' })
    const duplicate = f.service.execute('chat.startTurn', f.submission, { prepare: async () => {
      throw new Error('must reuse original preparation')
    }, commit: f.commit })
    await expect(f.service.execute('chat.startTurn', { ...f.submission, intent: { ...f.submission.intent, expectedRevision: 3 } }, { prepare: async () => {}, commit: f.commit })).rejects.toMatchObject({ code: 'COMMAND_ID_REUSED' })
    gate.resolve()
    const accepted = await first
    expect(await duplicate).toEqual({ created: false, receipt: accepted.receipt })
    expect(f.database.prepare('SELECT * FROM effects').all()).toEqual([{ id: 'original-effect' }])
    await expect(f.service.execute('chat.executeCommand', f.submission, { prepare: async () => {}, commit: f.commit })).rejects.toMatchObject({ code: 'COMMAND_ID_REUSED' })
  })

  it('keeps same command IDs isolated by authenticated actor and rejects revoked or wrong generations before lookup', async () => {
    const f = fixture()
    await f.service.execute('chat.startTurn', f.submission, { prepare: async () => {}, commit: f.commit })
    f.database.exec('INSERT INTO storage_actors VALUES (\'device-1\', \'device\', \'active\', \'2026-01-01T00:00:00.000Z\')')
    const device = f.createService('instance-1', { actorId: 'device-1', assertAuthenticated() {} })
    expect(device.lookup(f.identity)).toEqual({ lookup: 'not_found' })
    const own = await device.execute('chat.startTurn', f.submission, { prepare: async () => {}, commit: () => ({ target: { runId: 'device-run' }, result: {} }) })
    expect(own.receipt.actorId).toBe('device-1')
    f.database.exec('UPDATE storage_actors SET state = \'revoked\' WHERE id = \'device-1\'')
    expect(() => device.lookup(f.identity)).toThrowError(expect.objectContaining({ code: 'COMMAND_ACTOR_UNAVAILABLE' }))
    expect(() => f.service.lookup({ ...f.identity, dataGeneration: 'stale-generation' })).toThrowError(expect.objectContaining({ code: 'DATA_GENERATION_CHANGED' }))
    expect(() => f.service.lookup({ ...f.identity, actorId: 'device-1' })).toThrow()
  })

  it('persists explicit business rejection atomically and never converts arbitrary failures to receipts', async () => {
    const f = fixture()
    const rejected = await f.service.execute('chat.startTurn', f.submission, { prepare: async () => {}, validate: () => ({ errorCode: 'DRAFT_CONFLICT', target: { draftId: 'draft-1' }, result: { actualRevision: 3 } }), commit: f.commit })
    expect(rejected.receipt).toMatchObject({ decision: 'rejected', errorCode: 'DRAFT_CONFLICT', result: { actualRevision: 3 } })
    expect(f.database.prepare('SELECT * FROM effects').all()).toEqual([])
    expect(await f.service.execute('chat.startTurn', f.submission, { prepare: async () => {}, commit: f.commit })).toEqual({ created: false, receipt: rejected.receipt })
    const failure = new Error('storage write failed')
    await expect(f.service.execute('chat.startTurn', { ...f.submission, commandId: 'failed' }, { prepare: async () => {}, commit: () => {
      f.commit()
      throw failure
    } })).rejects.toBe(failure)
    expect(f.service.lookup({ ...f.identity, commandId: 'failed' })).toEqual({ lookup: 'not_found' })
    expect(f.database.prepare('SELECT * FROM effects').all()).toEqual([])
  })

  it('records an explicit commit conflict only after all attempted business changes are rolled back', async () => {
    const f = fixture()
    const conflict = new Error('draft conflict')
    const result = await f.service.execute('chat.startTurn', f.submission, {
      prepare: async () => {},
      commit: () => {
        f.commit()
        throw conflict
      },
      reject: error => error === conflict ? { errorCode: 'DRAFT_CONFLICT', target: { draftId: 'draft-1' }, result: {} } : null,
    })
    expect(result.receipt).toMatchObject({ decision: 'rejected', errorCode: 'DRAFT_CONFLICT' })
    expect(f.database.prepare('SELECT * FROM effects').all()).toEqual([])
    expect(f.service.lookup(f.identity)).toMatchObject({ lookup: 'decided', receipt: result.receipt })
  })

  it.each(['generation', 'actor'] as const)('rechecks %s after preparation inside final acceptance', async (change) => {
    const f = fixture()
    const gate = deferred()
    const execution = f.service.execute('chat.startTurn', f.submission, { prepare: async () => gate.promise, commit: f.commit })
    const expected = expect(execution).rejects.toMatchObject({ code: change === 'generation' ? 'DATA_GENERATION_CHANGED' : 'COMMAND_ACTOR_UNAVAILABLE' })
    if (change === 'generation')
      f.database.exec('UPDATE storage_profile SET data_generation = \'replacement\'')
    if (change === 'actor')
      f.database.exec('UPDATE storage_actors SET state = \'revoked\'')
    gate.resolve()
    await expected
    expect(f.database.prepare('SELECT * FROM command_receipts').all()).toEqual([])
    expect(f.database.prepare('SELECT * FROM effects').all()).toEqual([])
  })

  it('preserves unknown acceptance after a COMMIT error until verified on a reopened connection', async () => {
    const f = fixture(true)
    guardStorageDatabase(f.database)
    const exec = f.database.exec.bind(f.database)
    const spy = vi.spyOn(f.database, 'exec').mockImplementation((sql) => {
      exec(sql)
      if (sql === 'COMMIT')
        throw new Error('injected response loss')
    })
    await expect(f.service.execute('chat.startTurn', f.submission, { prepare: async () => {}, commit: f.commit })).rejects.toMatchObject({ code: 'COMMAND_RESULT_UNKNOWN', acceptance: 'unknown' })
    expect(() => f.service.lookup(f.identity)).toThrowError(expect.objectContaining({ code: 'COMMAND_RESULT_UNKNOWN' }))
    spy.mockRestore()
    f.database.close()
    const reopened = openBuddyMigrationCandidate({ databasePath: f.databasePath })
    databases.push(reopened)
    const service = new CommandAdmissionService({ database: reopened, sourceInstanceId: 'instance-2', principal: createLocalCommandPrincipal(reopened) })
    expect(service.lookup(f.identity)).toMatchObject({ lookup: 'decided', receipt: { decision: 'accepted', target: { runId: 'original-run' } } })
    expect(reopened.prepare('SELECT * FROM effects').all()).toEqual([{ id: 'original-effect' }])
  })

  it('fails closed on unsupported stored fingerprint versions without deriving a new identity', async () => {
    const f = fixture()
    new CommandCommitter(f.database).accept({ ...f.identity, actorId: f.principal.actorId, method: 'chat.startTurn', fingerprintVersion: 99, fingerprint: 'future', sourceInstanceId: 'instance-old' }, () => ({ target: {}, result: {} }))
    await expect(f.service.execute('chat.startTurn', f.submission, { prepare: async () => {}, commit: f.commit })).rejects.toBeInstanceOf(CommandAdmissionError)
    await expect(f.service.execute('chat.startTurn', f.submission, { prepare: async () => {}, commit: f.commit })).rejects.toMatchObject({ code: 'COMMAND_FINGERPRINT_UNSUPPORTED' })
    expect(f.database.prepare('SELECT * FROM effects').all()).toEqual([])
  })
})
