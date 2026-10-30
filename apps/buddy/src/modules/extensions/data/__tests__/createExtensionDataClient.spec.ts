import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionDataSnapshot } from '@buddy-shared/extensions/extensionData'
import type { ExtensionContext } from '../../extensionContext'
import type { ExtensionSurface } from '../../widgets/useExtensionViews'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import { ExtensionViewState } from '../../../../../electron/main/extensions/runtime/ExtensionViewState'
import { ExtensionViewProjection } from '../../widgets/ExtensionViewProjection'
import { createExtensionDataClient, extensionDataGrants } from '../createExtensionDataClient'

const query = { source: 'task.metrics', scope: 'bound' } as const
const ready: ExtensionDataSnapshot<'task.metrics'> = {
  source: 'task.metrics',
  status: 'ready',
  value: {
    taskId: '11111111-1111-4111-8111-111111111111',
    branchId: '22222222-2222-4222-8222-222222222222',
    turns: 1,
    steps: 2,
    tokens: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    throughput: { samples: 1, tokensPerSecond: 10 },
  },
}
const denied = { source: 'task.metrics', status: 'denied', value: null }
const disposals: (() => void)[] = []
afterEach(() => disposals.splice(0).forEach(dispose => dispose()))

function fixture(generation: string | null = null) {
  const installed = shallowRef([{
    manifest: { id: 'fixture', permissions: { data: ['task.metrics'] } },
    enabled: true,
    compatible: true,
    generation,
    state: 'active',
  }] as unknown as ExtensionStatus[])
  const surface = {
    input: { extensionId: 'fixture' },
    session: { generation: 'current', token: 'session' },
    eligible: true,
  } as ExtensionSurface
  const context = {
    state: { installed },
    data: {
      binding: () => ({ key: 'task', read: async () => ready }),
      observeChanges: () => () => {},
    },
  } as unknown as ExtensionContext
  const grants = extensionDataGrants(context, surface)
  const projection = new ExtensionViewProjection({
    workbench: { values: { page: 'tasks' }, pages: [] },
    environment: { language: 'zh-CN', colorScheme: 'light', colors: {} },
    visible: false,
    anchor: null,
    mount: null,
    control: null,
    data: {},
  }, { decoration: false, control: false, interaction: false, data: grants })
  const receiver = new ExtensionViewState()
  receiver.initialize(projection.synchronization.snapshot, false, projection.synchronization, false, grants)
  projection.onDidChange(update => receiver.acceptUpdate(update))
  const client = createExtensionDataClient(context, surface, data => projection.publish({ type: 'data:changed', data }))
  const id = crypto.randomUUID()
  client.observe({ id, query })
  disposals.push(() => {
    client.dispose()
    projection.dispose()
    receiver.dispose()
  })
  const update = (patch: Partial<ExtensionStatus>) => {
    installed.value = [{ ...installed.value[0]!, ...patch }]
  }
  return { client, installed, projection, receiver, id, update }
}

describe('extension data permission and session lifetimes', () => {
  it('retains approved grants while the restored session generation is still being synchronized', async () => {
    const { client, projection, receiver, id, update } = fixture()
    await vi.waitFor(() => expect(receiver.snapshot.data?.[id]).toEqual(denied))
    expect(await client.read(query)).toEqual(denied)
    update({ generation: 'current' })
    await vi.waitFor(() => expect(receiver.snapshot.data?.[id]).toEqual(ready))
    expect(projection.synchronization.snapshot.data?.[id]).toEqual(ready)
    expect(await client.read(query)).toEqual(ready)
    expect(await client.read({ source: 'context.usage', scope: 'bound' })).toEqual({ source: 'context.usage', status: 'denied', value: null })
  })

  it('still removes data from events and recovery when the generation or approved permissions are revoked', async () => {
    const { client, installed, projection, receiver, id, update } = fixture('current')
    await vi.waitFor(() => expect(receiver.snapshot.data?.[id]).toEqual(ready))
    update({ generation: 'replacement' })
    await vi.waitFor(() => expect(receiver.snapshot.data?.[id]).toEqual(denied))
    expect(projection.synchronization.snapshot.data?.[id]).toEqual(denied)
    update({ generation: 'current' })
    await vi.waitFor(() => expect(receiver.snapshot.data?.[id]).toEqual(ready))
    const manifest = installed.value[0]!.manifest
    update({ manifest: { ...manifest, permissions: { ...manifest.permissions, data: [] } } })
    await vi.waitFor(() => expect(receiver.snapshot.data?.[id]).toEqual(denied))
    expect(projection.synchronization.snapshot.data?.[id]).toEqual(denied)
    expect(await client.read(query)).toEqual(denied)
  })
})
