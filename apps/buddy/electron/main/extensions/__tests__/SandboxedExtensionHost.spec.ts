import type { EventEmitter } from 'node:events'
import type { ExtensionHostFailure } from '../../../../shared/extensions/extensionDiagnostic'
import type { JsonValue } from '../../../../shared/workbench/workbenchState'
import type { ExtensionProtocol } from '../ExtensionProtocol'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { createStore, manifest, reviewPackage } from '../../../../platform/extensions/__tests__/fixtures'
import { ExtensionService } from '../../../../platform/extensions/ExtensionService'
import { EXTENSION_IPC } from '../../../../shared/extensions/extensionApi'
import { createExtensionResourceClient } from '../../../../shared/extensions/extensionResourceClient'
import { SandboxedExtensionHost } from '../SandboxedExtensionHost'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class WebContents extends EventEmitter {
    readonly session: unknown
    constructor(session: unknown) {
      super()
      this.session = session
    }

    mainFrame = {}
    send(channel: string, message: unknown) { this.emit(channel, message) }
    setWindowOpenHandler() {}
    setDevToolsWebContents() {}
    openDevTools() {}
  }
  class BrowserWindow extends EventEmitter {
    readonly webContents: WebContents
    constructor(options: { webPreferences: { session: unknown } }) {
      super()
      this.webContents = new WebContents(options.webPreferences.session)
    }

    destroyed = false
    async loadURL() {}
    isDestroyed() { return this.destroyed }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  return {
    BrowserWindow,
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest: vi.fn() },
        async closeAllConnections() {},
      }),
    },
  }
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})

async function fixture() {
  const { root, store } = await createStore()
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const id = 'tests.upload'
  const value = manifest({ id, apiVersion: 4, permissions: {}, contributes: { commands: [{ id: `${id}.save`, title: 'Save' }] } })
  await store.install((await reviewPackage(root, store, value)).token)
  const failures: ExtensionHostFailure[] = []
  const gates = new Map<string, { entered: ReturnType<typeof deferred<void>>, done: ReturnType<typeof deferred<void>> }>()
  const endpoint = { token: 'fixture', url: 'lexora-extension://fixture/__host.html', dispose: vi.fn() }
  const stopProtocol = vi.fn()
  const protocol = {
    register: () => endpoint,
    install: () => stopProtocol,
  } as unknown as ExtensionProtocol
  let host!: SandboxedExtensionHost
  let commandMessage: ReturnType<typeof deferred<string>> | undefined
  let acknowledgeDeactivate = true
  let acknowledgeHeartbeat = true
  const messages: Array<{ id: string, method: string }> = []
  const service = new ExtensionService(store, {
    createHost: (pkg, broker, failed) => {
      host = new SandboxedExtensionHost(pkg, protocol, async (method, params) => {
        const gate = gates.get(method)
        if (gate) {
          gate.entered.resolve()
          await gate.done.promise
        }
        return broker(method, params)
      }, (failure) => {
        failures.push(failure)
        failed(failure)
      })
      const contents = host.window.webContents as unknown as EventEmitter
      contents.on(EXTENSION_IPC.hostMessage, (message: { id: string, method: string }) => {
        messages.push(message)
        if (message.method === 'ping' && !acknowledgeHeartbeat)
          return
        if (message.method === 'command' && commandMessage) {
          commandMessage.resolve(message.id)
        }
        else if (message.method !== 'deactivate' || acknowledgeDeactivate) {
          host.reply({ id: message.id, ok: true, value: null })
        }
      })
      void host.request('ready', null)
      return host
    },
    createView: () => { throw new Error('unexpected view') },
    workbench: async event => event.kind === 'clear-data' ? event.requestId : null,
    readText: async () => { throw new Error('unexpected external read') },
    get: async () => { throw new Error('unexpected network') },
    changed() {},
  })
  cleanup.push(async () => {
    for (const gate of gates.values()) gate.done.resolve()
    acknowledgeDeactivate = true
    await service.dispose()
  })
  await service.execute(id, `${id}.save`, null)
  const hold = (method: string) => {
    const gate = { entered: deferred<void>(), done: deferred<void>() }
    gates.set(method, gate)
    return gate
  }
  const command = async (signal?: AbortSignal) => {
    commandMessage = deferred<string>()
    const outcome: Promise<PromiseSettledResult<JsonValue>> = host.call('command', null, signal).then(
      value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }),
    )
    return { id: await commandMessage.promise, outcome }
  }
  const request = (method: string, params: JsonValue = null) => host.request(method, params)
  return { id, root, store, service, host, failures, endpoint, stopProtocol, hold, command, request, messages, resources: createExtensionResourceClient(request), heartbeat: (enabled: boolean) => {
    acknowledgeHeartbeat = enabled
  }, ignoreDeactivate: () => {
    acknowledgeDeactivate = false
  } }
}

it('keeps the bootstrap handshake deadline bounded before the runtime is ready', async () => {
  vi.useFakeTimers()
  const failures: ExtensionHostFailure[] = []
  const endpoint = { token: 'not-ready', url: 'lexora-extension://not-ready/__host.html', dispose() {} }
  const protocol = { register: () => endpoint, install: () => () => {} } as unknown as ExtensionProtocol
  const pkg = { manifest: manifest() } as ConstructorParameters<typeof SandboxedExtensionHost>[0]
  const host = new SandboxedExtensionHost(pkg, protocol, async () => null, failure => failures.push(failure))
  cleanup.push(() => host.dispose())
  const activation = expect(host.call('activate', null)).rejects.toThrow('EXTENSION_REQUEST_TIMEOUT')
  await vi.advanceTimersByTimeAsync(14999)
  expect(failures).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  await activation
  expect(failures).toEqual([{ code: 'EXTENSION_REQUEST_TIMEOUT', method: 'ready', stage: 'timeout' }])
  await expect(host.request('ready', null)).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await host.dispose()
  expect(host.window.isDestroyed()).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('completes a background SDK upload while slow storage RPCs outlast the former command deadline', async () => {
  const f = await fixture()
  const gates = ['resources.beginCreate', 'resources.writeChunk', 'resources.commitSave'].map(f.hold)
  vi.useFakeTimers()
  const command = await f.command()
  const saved = f.resources.createFile({ name: 'draft.txt', data: new Blob(['慢速落盘'], { type: 'text/plain;charset=utf-8' }) })
  for (const gate of gates) {
    await gate.entered.promise
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.failures).toEqual([])
    gate.done.resolve()
  }
  const file = await saved
  f.host.reply({ id: command.id, ok: true, value: file })
  expect(await command.outcome).toEqual({ status: 'fulfilled', value: file })
  expect(await f.resources.readText(file)).toBe('慢速落盘')
  expect(file.mimeType).toBe('text/plain')
  expect(f.host.window.isDestroyed()).toBe(false)
  await vi.advanceTimersByTimeAsync(20000)
  expect(f.failures).toEqual([])
})

it('allows an idle async operation but drains uploads when the host stops answering probes', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  const command = await f.command()
  await f.request('resources.beginCreate', { name: 'idle.bin', size: 4 })
  await vi.advanceTimersByTimeAsync(20000)
  expect(f.failures).toEqual([])
  f.heartbeat(false)
  await vi.advanceTimersByTimeAsync(20000)
  expect(await command.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_HOST_UNRESPONSIVE') })
  expect(f.failures).toEqual([{ code: 'EXTENSION_HOST_UNRESPONSIVE', method: 'ping', stage: 'timeout' }])
  await f.service.dispose()
  expect(f.host.window.isDestroyed()).toBe(true)
  expect(await f.store.resources.list(f.id, false)).toEqual([])
  expect(await readdir(join(f.root, 'extensions', 'data', f.id, 'files'))).toEqual([])
})

it('keeps concurrent async storage requests independent of host responsiveness', async () => {
  const f = await fixture()
  const existing = await f.request('resources.beginCreate', { name: 'first.bin', size: 1 })
  const create = f.hold('resources.beginCreate')
  const cancel = f.hold('resources.cancelSave')
  vi.useFakeTimers()
  const command = await f.command()
  const creating = f.request('resources.beginCreate', { name: 'second.bin', size: 1 })
  const cancelling = f.request('resources.cancelSave', { id: existing })
  await Promise.all([create.entered.promise, cancel.entered.promise])
  create.done.resolve()
  await creating
  await vi.advanceTimersByTimeAsync(20000)
  expect(f.failures).toEqual([])
  cancel.done.resolve()
  await cancelling
  await vi.advanceTimersByTimeAsync(20000)
  expect(f.failures).toEqual([])
  f.host.reply({ id: command.id, ok: true, value: null })
  expect(await command.outcome).toEqual({ status: 'fulfilled', value: null })
  await f.service.dispose()
  expect(await f.store.resources.list(f.id, false)).toEqual([])
})

it('reports a failed storage operation without terminating a responsive host', async () => {
  const f = await fixture()
  const gate = f.hold('resources.writeChunk')
  vi.useFakeTimers()
  const command = await f.command()
  const rejected = expect(f.request('resources.writeChunk')).rejects.toThrow('EXTENSION_RESOURCE_WRITE_FAILED')
  await gate.entered.promise
  await vi.advanceTimersByTimeAsync(20000)
  expect(f.failures).toEqual([])
  gate.done.reject(new Error('EXTENSION_RESOURCE_WRITE_FAILED'))
  await rejected
  f.host.reply({ id: command.id, ok: false, value: 'EXTENSION_RESOURCE_WRITE_FAILED' })
  expect(await command.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_RESOURCE_WRITE_FAILED') })
  await vi.advanceTimersByTimeAsync(20000)
  expect(f.failures).toEqual([])
  expect(f.host.window.isDestroyed()).toBe(false)
})

it('cancels an SDK upload and its command while a chunk is pending without retaining resources', async () => {
  const f = await fixture()
  const gate = f.hold('resources.writeChunk')
  const controller = new AbortController()
  vi.useFakeTimers()
  const command = await f.command(controller.signal)
  const pending = f.resources.createFile({ name: 'cancelled.txt', data: new Blob(['cancelled']), signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow()
  await gate.entered.promise
  await vi.advanceTimersByTimeAsync(20000)
  controller.abort()
  expect(await command.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_AGENT_CANCELLED') })
  await f.service.enable(f.id, false)
  expect(f.host.window.isDestroyed()).toBe(true)
  gate.done.resolve()
  await rejected
  expect(await f.store.resources.list(f.id, false)).toEqual([])
  expect(await readdir(join(f.root, 'extensions', 'data', f.id, 'files'))).toEqual([])
  expect(f.failures).toEqual([])
})

it('keeps forced deactivation bounded even while a storage RPC is still pending', async () => {
  const f = await fixture()
  const gate = f.hold('resources.beginCreate')
  vi.useFakeTimers()
  const command = await f.command()
  const rejected = expect(f.request('resources.beginCreate', { name: 'late.bin', size: 0 })).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await gate.entered.promise
  f.ignoreDeactivate()
  const disposed = f.host.dispose()
  expect(await command.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_HOST_STOPPED') })
  await vi.advanceTimersByTimeAsync(1500)
  await disposed
  expect(f.host.window.isDestroyed()).toBe(true)
  await f.service.enable(f.id, false)
  gate.done.resolve()
  await rejected
  expect(await f.store.resources.list(f.id, false)).toEqual([])
  expect(f.failures).toEqual([])
})

it('keeps a slow binary read alive and accepts another command while it is pending', async () => {
  const f = await fixture()
  const file = await f.resources.createFile({ name: 'model.gguf', data: new Blob(['GGUF']) })
  const gate = f.hold('resources.readBytes')
  vi.useFakeTimers()
  const first = await f.command()
  const read = f.resources.readBytes(file)
  await gate.entered.promise
  await vi.advanceTimersByTimeAsync(45000)
  expect(f.failures).toEqual([])
  const second = await f.command()
  f.host.reply({ id: second.id, ok: true, value: 'responsive' })
  expect(await second.outcome).toEqual({ status: 'fulfilled', value: 'responsive' })
  gate.done.resolve()
  expect(new TextDecoder().decode((await read).data)).toBe('GGUF')
  f.host.reply({ id: first.id, ok: true, value: null })
  expect(await first.outcome).toEqual({ status: 'fulfilled', value: null })
  expect(vi.getTimerCount()).toBe(0)
})

it('does not let a pending I/O RPC hide an unresponsive host', async () => {
  const f = await fixture()
  const gate = f.hold('resources.beginCreate')
  vi.useFakeTimers()
  f.heartbeat(false)
  const command = await f.command()
  const read = f.request('resources.beginCreate', { name: 'blocked.bin', size: 0 }).catch(error => error)
  await gate.entered.promise
  await vi.advanceTimersByTimeAsync(19999)
  expect(f.failures).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(await command.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_HOST_UNRESPONSIVE') })
  expect(f.failures).toHaveLength(1)
  await expect(f.host.call('command', null)).rejects.toThrow('EXTENSION_HOST_STOPPED')
  gate.done.resolve()
  await read
  await f.service.dispose()
  expect(f.host.window.isDestroyed()).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('settles a send failure once without leaking a waiter or heartbeat', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  vi.spyOn(f.host.window.webContents, 'send').mockImplementationOnce(() => {
    throw new Error('send failed')
  })
  await expect(f.host.call('command', null)).rejects.toThrow('send failed')
  expect(f.failures).toEqual([{ code: 'EXTENSION_HOST_CRASHED', method: 'unknown', stage: 'process' }])
  await f.service.dispose()
  expect(f.host.window.isDestroyed()).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps heartbeat capacity separate from all 64 pending business calls', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  const commands = []
  for (let i = 0; i < 64; i++) commands.push(await f.command())
  await expect(f.host.call('command', null)).rejects.toThrow('EXTENSION_REQUEST_LIMIT')
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.messages.filter(message => message.method === 'ping')).toHaveLength(6)
  expect(f.failures).toEqual([])
  for (const command of commands) {
    f.host.reply({ id: command.id, ok: true, value: null })
    expect(await command.outcome).toEqual({ status: 'fulfilled', value: null })
  }
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels the last waiter and ignores its late result and outstanding pong', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  f.heartbeat(false)
  const abort = new AbortController()
  const command = await f.command(abort.signal)
  await vi.advanceTimersByTimeAsync(5000)
  const ping = f.messages.find(message => message.method === 'ping')!
  abort.abort()
  expect(await command.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_AGENT_CANCELLED') })
  expect(vi.getTimerCount()).toBe(0)
  f.host.reply({ id: ping.id, ok: true, value: null })
  f.host.reply({ id: command.id, ok: true, value: 'late' })
  await vi.advanceTimersByTimeAsync(60000)
  expect(f.failures).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it('does not let a stale or unsuccessful pong satisfy a newer probe', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  f.heartbeat(false)
  const abort = new AbortController()
  const first = await f.command(abort.signal)
  await vi.advanceTimersByTimeAsync(5000)
  const oldPing = f.messages.at(-1)!
  abort.abort()
  await first.outcome
  const second = await f.command()
  await vi.advanceTimersByTimeAsync(5000)
  const ping = f.messages.at(-1)!
  f.host.reply({ id: oldPing.id, ok: true, value: null })
  f.host.reply({ id: ping.id, ok: false, value: 'EXTENSION_OPERATION_FAILED' })
  await vi.advanceTimersByTimeAsync(15000)
  expect(await second.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_HOST_UNRESPONSIVE') })
  expect(f.failures).toHaveLength(1)
})

it.each([16000, 60000, -60000])('re-probes after an observation gap or clock change of %i ms', async (gap) => {
  const f = await fixture()
  vi.useFakeTimers()
  f.heartbeat(false)
  const command = await f.command()
  await vi.advanceTimersByTimeAsync(5000)
  vi.setSystemTime(Date.now() + gap)
  f.heartbeat(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.messages.filter(message => message.method === 'ping')).toHaveLength(2)
  expect(f.failures).toEqual([])
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.failures).toEqual([])
  f.host.reply({ id: command.id, ok: true, value: null })
  expect(await command.outcome).toEqual({ status: 'fulfilled', value: null })
  expect(vi.getTimerCount()).toBe(0)
})
