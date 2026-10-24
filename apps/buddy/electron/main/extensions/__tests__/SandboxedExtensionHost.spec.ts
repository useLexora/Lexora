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
    mainFrame = {}
    send(channel: string, message: unknown) { this.emit(channel, message) }
    setWindowOpenHandler() {}
  }
  class BrowserWindow extends EventEmitter {
    webContents = new WebContents()
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
        webRequest: { onBeforeRequest() {} },
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
  const protocol = {
    register: () => ({ token: 'fixture', url: 'lexora-extension://fixture/__host.html', dispose() {} }),
    install: () => () => {},
  } as unknown as ExtensionProtocol
  let host!: SandboxedExtensionHost
  let commandMessage: ReturnType<typeof deferred<string>> | undefined
  let acknowledgeDeactivate = true
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
    workbench: async () => null,
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
  return { id, root, store, service, host, failures, hold, command, request, resources: createExtensionResourceClient(request), ignoreDeactivate: () => {
    acknowledgeDeactivate = false
  } }
}

it('completes a background SDK upload through the real host when each storage RPC exceeds the command deadline', async () => {
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

it('does not pause the command while an upload is idle between RPCs and drains it on timeout', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  const command = await f.command()
  await f.request('resources.beginCreate', { name: 'idle.bin', size: 4 })
  await vi.advanceTimersByTimeAsync(15000)
  expect(await command.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_REQUEST_TIMEOUT') })
  expect(f.failures).toEqual([{ code: 'EXTENSION_REQUEST_TIMEOUT', method: 'command', stage: 'timeout' }])
  await f.service.dispose()
  expect(f.host.window.isDestroyed()).toBe(true)
  expect(await f.store.resources.list(f.id, false)).toEqual([])
  expect(await readdir(join(f.root, 'extensions', 'data', f.id, 'files'))).toEqual([])
})

it('keeps the command paused until all concurrent storage requests settle, then resumes its ordinary deadline', async () => {
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
  await vi.advanceTimersByTimeAsync(14999)
  expect(f.failures).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(await command.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_REQUEST_TIMEOUT') })
  await f.service.dispose()
  expect(await f.store.resources.list(f.id, false)).toEqual([])
})

it('restores timeout enforcement after a storage request fails', async () => {
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
  await vi.advanceTimersByTimeAsync(15000)
  expect(await command.outcome).toMatchObject({ status: 'rejected', reason: new Error('EXTENSION_REQUEST_TIMEOUT') })
  expect(f.failures).toHaveLength(1)
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
