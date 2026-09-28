import type { ExtensionServicePorts } from '../ExtensionService'
import type { ExtensionServiceChange } from '../ExtensionServiceEvents'
import { rm } from 'node:fs/promises'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest, reviewPackage } from './fixtures'

async function fixture(call?: ExtensionServicePorts['createHost']) {
  const { root, store } = await createStore()
  const definition = manifest({ id: 'tests.events', apiVersion: 3, contributes: { commands: [{ id: 'tests.events.open', title: 'Open' }], settings: { groups: [{ id: 'tests.events.group', module: 'settings.runtime', title: 'Settings' }], items: [{ id: 'tests.events.name', group: 'tests.events.group', key: 'name', title: 'Name', type: 'string', default: 'fixture-private-initial' }] } } })
  await store.install((await reviewPackage(root, store, definition)).token)
  const service = new ExtensionService(store, { createHost: call ?? (() => ({ call: async () => null, dispose: async () => {}, devtools() {} })), createView: () => {
    throw new Error('unused')
  }, get: async () => new Response(''), readText: async () => '', workbench: async () => null })
  const changes: ExtensionServiceChange[] = []
  service.onDidChange(change => changes.push(change))
  onTestFinished(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await service.initialize()
  return { service, store, changes }
}

afterEach(() => vi.useRealTimers())

describe('extension service facts', () => {
  it('publishes committed configuration after persistence, skips no-ops and preserves the accepted state after a failed write', async () => {
    const { service, store, changes } = await fixture()
    changes.length = 0
    await service.configure('tests.events', { name: 'fixture-private-initial' })
    expect(changes.filter(change => change.kind === 'configuration')).toEqual([])
    vi.spyOn(store, 'saveConfiguration').mockRejectedValueOnce(new Error('fixture-private-write-failure'))
    await expect(service.configure('tests.events', { name: 'fixture-private-next' })).rejects.toThrow('fixture-private-write-failure')
    expect(changes.filter(change => change.kind === 'configuration')).toEqual([])
    expect(await service.configuration('tests.events')).toEqual({ name: 'fixture-private-initial' })
    await service.configure('tests.events', { name: 'fixture-private-next' })
    const configuration = changes.filter(change => change.kind === 'configuration')
    expect(configuration.map(change => change.application.status)).toEqual(['committed', 'deferred'])
    expect(service.snapshot.extensions[0]?.configuration).toMatchObject({ status: 'deferred', operationId: configuration[0]!.application.operationId })
    expect(JSON.stringify(configuration)).not.toContain('fixture-private')
    expect(Object.isFrozen(service.snapshot.extensions[0]!.configuration)).toBe(true)
  })

  it.each(['retired', 'timeout'] as const)('keeps a saved configuration while fencing a %s application result', async (mode) => {
    const applyStarted = deferred<void>()
    const apply = deferred<Awaited<ReturnType<ReturnType<ExtensionServicePorts['createHost']>['call']>>>()
    let acknowledgement!: { operationId: string, generation: string, configurationRevision: string, applied: boolean }
    const { service, changes } = await fixture(() => ({
      call: async (method, params) => {
        if (method === 'configuration.changed') {
          acknowledgement = { ...params as unknown as typeof acknowledgement, applied: true }
          applyStarted.resolve()
          return apply.promise
        }
        return null
      },
      dispose: async () => {},
      devtools() {},
    }))
    await service.execute('tests.events', 'tests.events.open', null)
    const generation = service.snapshot.extensions[0]!.generation
    if (mode === 'timeout')
      vi.useFakeTimers()
    const configuring = service.configure('tests.events', { name: 'fixture-private-next' })
    await applyStarted.promise
    if (mode === 'retired') {
      await service.resetHosts()
      apply.resolve({ operationId: acknowledgement.operationId, generation: acknowledgement.generation, configurationRevision: acknowledgement.configurationRevision, applied: true })
    }
    else {
      await vi.advanceTimersByTimeAsync(15000)
    }
    await configuring
    expect(await service.configuration('tests.events')).toEqual({ name: 'fixture-private-next' })
    const phases = changes.filter(change => change.kind === 'configuration').map(change => change.application.status)
    expect(phases).toEqual(['committed', 'apply-failed', 'invalidated'])
    expect(service.snapshot.extensions[0]!.generation).toBeNull()
    expect(service.snapshot.extensions[0]!.configuration).toMatchObject({ status: 'invalidated', generation, errorCode: mode === 'timeout' ? 'EXTENSION_CONFIGURATION_UPDATE_TIMEOUT' : 'EXTENSION_HOST_STOPPED' })
    expect(changes.filter(change => change.kind === 'host').filter(change => change.generation === generation).map(change => change.status)).toEqual(['starting', 'active', 'stopping', 'stopped'])
    if (mode === 'timeout') {
      apply.resolve({ operationId: acknowledgement.operationId, generation: acknowledgement.generation, configurationRevision: acknowledgement.configurationRevision, applied: true })
      await Promise.resolve()
      expect(changes.filter(change => change.kind === 'configuration' && change.application.status === 'applied')).toEqual([])
    }
  })

  it('retains generation invalidation when the retired host fails to stop', async () => {
    const { service, changes } = await fixture(() => ({
      call: async (method, params) => {
        if (method !== 'configuration.changed')
          return null
        const input = params as { operationId: string, generation: string, configurationRevision: string }
        return { operationId: input.operationId, generation: input.generation, configurationRevision: input.configurationRevision, applied: false }
      },
      dispose: async () => { throw new Error('EXTENSION_HOST_STOP_FAILED') },
      devtools() {},
    }))
    await service.execute('tests.events', 'tests.events.open', null)
    await expect(service.configure('tests.events', { name: 'fixture-private-next' })).rejects.toThrow('EXTENSION_HOST_STOP_FAILED')
    expect(await service.configuration('tests.events')).toEqual({ name: 'fixture-private-next' })
    expect(service.snapshot.extensions[0]).toMatchObject({ generation: null, active: false, configuration: { status: 'invalidated' } })
    expect(changes.filter(change => change.kind === 'configuration').map(change => change.application.status)).toEqual(['committed', 'invalidated'])
    expect(changes.filter(change => change.kind === 'host').at(-1)).toMatchObject({ status: 'stop-failed', errorCode: 'EXTENSION_HOST_STOP_FAILED' })
  })
})
