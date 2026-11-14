import type { ProductIdentity } from '../../../../shared/productProtocol/identity'
import type { DesktopProductConnection } from '../DesktopProductCommands'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopProductCommands } from '../DesktopProductCommands'
import { ProductOutboxStore } from '../ProductOutboxStore'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const identity: ProductIdentity = { serviceId: 'service', profileId: 'profile', dataGeneration: 'data', serviceInstanceId: 'instance', connectionId: 'connection', clientSessionId: 'session', deviceId: 'desktop-owner' }
const command = { method: 'chat.startTurn' as const, commandId: 'command', intent: { draftId: 'draft', expectedRevision: '2' } }
const receipt = { dataGeneration: 'data', commandId: 'command', method: 'chat.startTurn', decision: 'accepted' as const, decidedAt: '2026-11-07T00:00:00.000Z', target: { runId: 'run', draftId: 'draft' }, result: { draftReceipt: { draftId: 'draft', committedRevision: '3' } } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-product-outbox-'))
  roots.push(root)
  const store = new ProductOutboxStore(join(root, 'outbox'))
  return { root, store, client: new DesktopProductCommands(store) }
}

function connection(request: DesktopProductConnection['request'], changes: Partial<ProductIdentity> = {}): DesktopProductConnection {
  return { identity: { ...identity, ...changes }, request }
}

describe('desktop durable command delivery', () => {
  it('persists before dispatch, reconciles a lost response after restart and retains deduplication after archival', async () => {
    const { root, store, client } = await fixture()
    let dispatched = 0
    client.attach(connection(async () => {
      dispatched += 1
      const [persisted] = await new ProductOutboxStore(join(root, 'outbox')).list()
      expect(persisted).toMatchObject({ state: 'uncertain', envelope: { commandId: 'command', intent: command.intent } })
      throw new Error('transport lost after commit')
    }))
    const first = await client.execute(command)
    expect(first.state).toBe('unknown')
    expect(dispatched).toBe(1)
    const restarted = new DesktopProductCommands(new ProductOutboxStore(store.directory))
    const calls: string[] = []
    restarted.attach(connection(async (method) => {
      calls.push(method)
      return { lookup: 'decided', receipt }
    }, { serviceInstanceId: 'instance-2' }))
    const [recovered] = await restarted.recover()
    expect(recovered).toMatchObject({ state: 'decided', record: { receipt } })
    expect(calls).toEqual(['commands.get'])
    const archived = await store.archive(recovered!.record)
    expect(archived.envelope).toBeNull()
    expect(archived.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect((await restarted.execute(command)).state).toBe('decided')
    expect(calls).toEqual(['commands.get'])
    await expect(restarted.execute({ ...command, intent: { ...command.intent, expectedRevision: '3' } })).rejects.toThrow('OUTBOX_COMMAND_ID_REUSED')
  })

  it('does not send when durable preparation fails', async () => {
    const { root } = await fixture()
    const directory = join(root, 'not-a-directory')
    await writeFile(directory, 'keep')
    const client = new DesktopProductCommands(new ProductOutboxStore(directory))
    let dispatched = 0
    client.attach(connection(async () => {
      dispatched += 1
    }))
    await expect(client.execute(command)).rejects.toThrow()
    expect(dispatched).toBe(0)
    expect(await readFile(directory, 'utf8')).toBe('keep')
  })

  it('returns absent commands as recoverable input and never changes identity or resends automatically', async () => {
    const { store, client } = await fixture()
    const record = await store.create({ identity, method: command.method, envelope: { dataGeneration: identity.dataGeneration, commandId: command.commandId, expectedServiceInstanceId: identity.serviceInstanceId, intent: command.intent } })
    const calls: string[] = []
    client.attach(connection(async (method) => {
      calls.push(method)
      return { lookup: 'not_found' }
    }))
    expect((await client.reconcile(record.record)).state).toBe('not_accepted')
    expect((await store.list())[0]!.envelope?.intent).toEqual(command.intent)
    client.attach(connection(async (method) => {
      calls.push(method)
    }, { dataGeneration: 'restored-data' }))
    expect((await client.recover())[0]!.state).toBe('trust_changed')
    expect(calls).toEqual(['commands.get'])
    expect((await store.list())[0]!.owner.dataGeneration).toBe('data')
  })

  it('keeps unknown results and corrupted records without silently reconstructing an empty outbox', async () => {
    const { store, client } = await fixture()
    client.attach(connection(async () => ({ receipt: { ...receipt, commandId: 'another-command' } })))
    expect((await client.execute(command)).state).toBe('unknown')
    client.attach(connection(async () => {
      throw new Error('storage unavailable')
    }))
    expect((await client.recover())[0]!.state).toBe('unknown')
    const [name] = await readdir(store.directory)
    await writeFile(join(store.directory, name!), '{broken')
    await expect(client.recover()).rejects.toThrow()
    expect(await readFile(join(store.directory, name!), 'utf8')).toBe('{broken')
  })

  it('archives the original receipt but fences a late response from the replaced window connection', async () => {
    const { client, store } = await fixture()
    let respond!: (result: unknown) => void
    let sent!: () => void
    const dispatched = new Promise<void>((resolve) => {
      sent = resolve
    })
    const detach = client.attach(connection(async () => {
      sent()
      return new Promise((resolve) => {
        respond = resolve
      })
    }))
    const sending = client.execute(command)
    await dispatched
    client.attach(connection(async () => ({ lookup: 'decided', receipt }), { connectionId: 'new-window', clientSessionId: 'new-session' }))
    detach()
    respond({ receipt })
    expect((await sending).state).toBe('connection_replaced')
    expect((await store.list())[0]!.receipt).toEqual(receipt)
    expect((await client.recover())[0]!.state).toBe('decided')
  })

  it('serializes concurrent retries of one identity without returning an early not-found result', async () => {
    const { client } = await fixture()
    let dispatched = 0
    client.attach(connection(async (method) => {
      if (method === 'commands.get')
        return { lookup: 'not_found' }
      dispatched += 1
      return { receipt }
    }))
    const results = await Promise.all([client.execute(command), client.execute(command)])
    expect(results.map(result => result.state)).toEqual(['decided', 'decided'])
    expect(dispatched).toBe(1)
  })
})
