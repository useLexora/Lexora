import type { CredentialVault } from '../../secrets/CredentialVault'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SyncHub } from '../SyncHub'

it('keeps the previous endpoint paired with its credential if saving a replacement fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-sync-credentials-'))
  const values = new Map<string, unknown>()
  const credentials: CredentialVault = {
    read: async (_namespace, id) => values.get(id) ?? null,
    write: async (_namespace, id, value) => { values.set(id, value) },
    delete: async (_namespace, id) => { values.delete(id) },
    listProviders: async () => [],
  }
  const requests: Array<{ url: string, authorization?: string }> = []
  const hub = new SyncHub(root, credentials, async (url, init) => {
    requests.push({ url, authorization: init.headers.Authorization })
    return new Response('', { status: 207 })
  }, () => {})
  try {
    await hub.initialize()
    await hub.setEnabled(true)
    const original = { name: 'Original', adapter: 'webdav' as const, endpoint: 'https://original.invalid/dav/', username: 'fixture', password: 'old-synthetic' }
    const first = await hub.save(original)
    const id = first.connections[0]!.id
    const configuration = join(root, 'device', 'sync.json')
    await rename(configuration, `${configuration}.previous`)
    await mkdir(configuration)
    await expect(hub.save({ ...original, id, endpoint: 'https://replacement.invalid/dav/', password: 'new-synthetic' })).rejects.toThrow()
    await hub.run('test', id)
    expect(requests).toEqual([{ url: original.endpoint, authorization: `Basic ${Buffer.from('fixture:old-synthetic').toString('base64')}` }])
    expect(hub.state().connections).toEqual(first.connections)
    expect(JSON.stringify(hub.state())).not.toContain('synthetic')
  }
  finally {
    hub.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps WebDAV and S3 connections independent and retains a saved S3 secret when editing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-sync-adapters-'))
  const values = new Map<string, unknown>()
  const credentials: CredentialVault = {
    read: async (_namespace, id) => values.get(id) ?? null,
    write: async (_namespace, id, value) => { values.set(id, value) },
    delete: async (_namespace, id) => { values.delete(id) },
    listProviders: async () => [],
  }
  const transport = async () => new Response(null, { status: 200 })
  const hub = new SyncHub(root, credentials, transport, () => {})
  const reopened = new SyncHub(root, credentials, transport, () => {})
  try {
    await hub.initialize()
    await hub.setEnabled(true)
    await hub.save({ name: 'WebDAV', adapter: 'webdav', endpoint: 'https://dav.invalid/', username: 'fixture', password: 'dav-only' })
    const s3 = { name: 'S3', adapter: 's3' as const, endpoint: 'https://s3.invalid/', bucket: 'fixture-bucket', prefix: '', region: 'us-east-1', accessKeyId: 'fixture', pathStyle: true }
    await expect(hub.save(s3)).rejects.toThrow('SYNC_CREDENTIAL_REQUIRED')
    const state = await hub.save({ ...s3, password: 's3-only' })
    const id = state.connections.find(item => item.adapter === 's3')!.id
    await hub.save({ ...s3, id, name: 'Edited S3', prefix: 'new-prefix' })
    expect([...values.values()].sort()).toEqual(['dav-only', 's3-only'])
    const davId = hub.state().connections.find(item => item.adapter === 'webdav')!.id
    expect(hub.state().activeConnectionId).toBe(davId)
    await hub.selectAdapter('s3')
    expect(hub.state().activeConnectionId).toBe(id)
    await reopened.initialize()
    expect(reopened.state().selectedAdapter).toBe('s3')
    expect(reopened.state().activeConnectionId).toBe(id)
    expect(reopened.state().connections).toEqual(hub.state().connections)
    expect(reopened.state().connections).toHaveLength(2)
    await reopened.run('test', id)
    await reopened.remove(id)
    expect(reopened.state().connections[0]?.adapter).toBe('webdav')
    expect([...values.values()]).toEqual(['dav-only'])
  }
  finally {
    hub.dispose()
    reopened.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('persists the backup switch without removing connections or credentials and reads older configurations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-sync-switch-'))
  const values = new Map<string, unknown>()
  const credentials: CredentialVault = {
    read: async (_namespace, id) => values.get(id) ?? null,
    write: async (_namespace, id, value) => { values.set(id, value) },
    delete: async (_namespace, id) => { values.delete(id) },
    listProviders: async () => [],
  }
  const transport = async () => new Response('', { status: 207 })
  const open = async () => {
    const hub = new SyncHub(root, credentials, transport, () => {})
    await hub.initialize()
    return hub
  }
  try {
    const hub = await open()
    expect(hub.state().enabled).toBe(false)
    const saved = await hub.save({ adapter: 'webdav', name: 'lexora', endpoint: 'https://dav.invalid/', username: 'fixture', password: 'fixture-secret' })
    const id = saved.connections[0]!.id
    await expect(hub.run('test', id)).rejects.toThrow('SYNC_DISABLED')
    await hub.setEnabled(true)
    await hub.run('test', id)
    await hub.setEnabled(false)
    const reopened = await open()
    expect(reopened.state()).toEqual({ enabled: false, selectedAdapter: 'webdav', activeConnectionId: id, connections: saved.connections, activity: null, schedules: [], scheduleError: false })
    await expect(reopened.run('test', id)).rejects.toThrow('SYNC_DISABLED')
    expect([...values.values()]).toEqual(['fixture-secret'])
    const path = join(root, 'device', 'sync.json')
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    delete legacy.enabled
    await writeFile(path, JSON.stringify(legacy))
    const upgraded = await open()
    expect(upgraded.state().enabled).toBe(true)
    await upgraded.run('test', id)
    await rename(path, `${path}.previous`)
    await mkdir(path)
    await expect(upgraded.setEnabled(false)).rejects.toThrow()
    expect(upgraded.state().enabled).toBe(true)
    hub.dispose()
    reopened.dispose()
    upgraded.dispose()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
