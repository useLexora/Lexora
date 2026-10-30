import type { ExtensionDataSnapshot } from '../extensionData'
import type { ExtensionViewNotification } from '../extensionEvents'
import type { ExtensionViewPolicy, ExtensionViewSnapshot } from '../extensionViewProjection'
import { expect, it } from 'vitest'
import { parseExtensionRequestParams } from '../extensionApi'
import { extensionDataQuerySchema, extensionDataSnapshotSchema } from '../extensionData'
import { addedExtensionPermissions, extensionPermissionsSchema } from '../extensionManifest'
import { ownExtensionViewSnapshot, projectExtensionViewEvent } from '../extensionViewProjection'

const policy: ExtensionViewPolicy = { decoration: false, control: false, interaction: false }
const metrics: ExtensionDataSnapshot<'task.metrics'> = { source: 'task.metrics', status: 'ready', value: { taskId: 'task-one', branchId: 'branch-one', turns: 2, steps: 3, tokens: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 }, throughput: { samples: 0, tokensPerSecond: null } } }
const context: ExtensionDataSnapshot<'context.usage'> = { source: 'context.usage', status: 'ready', value: { taskId: 'task-one', branchId: 'branch-one', actorId: 'actor-one', runId: null, tokens: 80, window: 1000, percent: 8 } }
const snapshot: ExtensionViewSnapshot = { workbench: { values: {}, pages: [] }, environment: { language: 'en-US', colorScheme: 'light', colors: {} }, visible: true, mount: null, anchor: null, control: null }
const id = '17071b75-815d-4a75-9f7b-9f5654c02b50'

it('defaults old manifests to no data and reviews each newly requested source independently', () => {
  const previous = extensionPermissionsSchema.parse({})
  const taskOnly = extensionPermissionsSchema.parse({ data: ['task.metrics'] })
  const both = extensionPermissionsSchema.parse({ data: ['task.metrics', 'context.usage'] })
  expect(previous.data).toEqual([])
  expect(addedExtensionPermissions(previous, taskOnly)).toEqual(['data:task.metrics'])
  expect(addedExtensionPermissions(undefined, both)).toEqual(['data:task.metrics', 'data:context.usage'])
  expect(addedExtensionPermissions(taskOnly, both)).toEqual(['data:context.usage'])
  expect(addedExtensionPermissions(both, taskOnly)).toEqual([])
  expect(addedExtensionPermissions(both, both)).toEqual([])
  for (const data of [true, ['all'], ['task.metrics', 'task.metrics']])
    expect(extensionPermissionsSchema.safeParse({ data }).success).toBe(false)
})

it('validates bound-only queries and each exact request envelope', () => {
  const query = { source: 'task.metrics', scope: 'bound' }
  expect(parseExtensionRequestParams('data.read', query)).toEqual(query)
  expect(parseExtensionRequestParams('data.observe', { id, query })).toEqual({ id, query })
  expect(parseExtensionRequestParams('data.unobserve', { id })).toEqual({ id })
  for (const invalid of [{ ...query, taskId: 'other' }, { ...query, scope: 'global' }, { ...query, source: 'unknown' }])
    expect(extensionDataQuerySchema.safeParse(invalid).success).toBe(false)
  expect(() => parseExtensionRequestParams('data.observe', { id: 'not-a-uuid', query })).toThrow()
  expect(() => parseExtensionRequestParams('data.unobserve', { id, query })).toThrow()
})

it('discriminates source values and allows only null for unavailable states', () => {
  expect(extensionDataSnapshotSchema.parse(metrics)).toEqual(metrics)
  expect(extensionDataSnapshotSchema.parse(context)).toEqual(context)
  for (const status of ['denied', 'no_target', 'unavailable']) {
    expect(extensionDataSnapshotSchema.parse({ source: 'task.metrics', status, value: null })).toEqual({ source: 'task.metrics', status, value: null })
    expect(extensionDataSnapshotSchema.safeParse({ ...metrics, status }).success).toBe(false)
  }
  expect(extensionDataSnapshotSchema.safeParse({ ...metrics, source: 'context.usage' }).success).toBe(false)
  expect(extensionDataSnapshotSchema.safeParse({ ...context, value: { ...context.value, actorId: null } }).success).toBe(false)
  expect(extensionDataSnapshotSchema.safeParse({ ...metrics, value: { ...metrics.value, text: 'private' } }).success).toBe(false)
})

it('normalizes unapproved source snapshots and notifications to denied without exposing scope', () => {
  const denied = { source: 'task.metrics', status: 'denied', value: null }
  const owned = ownExtensionViewSnapshot({ ...snapshot, data: { [id]: metrics } }, policy)
  expect(owned.data).toEqual({ [id]: denied })
  const result = projectExtensionViewEvent(ownExtensionViewSnapshot(snapshot, policy), { type: 'data:changed', data: { id, snapshot: metrics } }, policy)
  expect(result?.event).toEqual({ type: 'data:changed', data: { id, snapshot: denied } })
  expect(result?.snapshot.data).toEqual({ [id]: denied })
})

it.each([false, true])('gates each source independently of decoration=%s and removes cancelled entries', (decoration) => {
  const allowed = { ...policy, decoration, data: ['task.metrics' as const] }
  expect(ownExtensionViewSnapshot(snapshot, allowed).data).toEqual({})
  const owned = ownExtensionViewSnapshot({ ...snapshot, data: { metrics, context } }, allowed)
  expect(owned.data).toEqual({ metrics, context: { source: 'context.usage', status: 'denied', value: null } })
  expect(owned.data?.metrics).not.toBe(metrics)
  const ownedMetrics = owned.data?.metrics
  if (ownedMetrics?.source === 'task.metrics' && ownedMetrics.status === 'ready')
    expect(Object.isFrozen(ownedMetrics.value.tokens)).toBe(true)
  const changed = { type: 'data:changed' as const, data: { id: 'metrics', snapshot: metrics } }
  expect(projectExtensionViewEvent(owned, changed, allowed)).toBeNull()
  const removed = projectExtensionViewEvent(owned, { type: 'data:changed', data: { id: 'metrics', snapshot: null } }, allowed)
  expect(removed?.snapshot.data).toEqual({ context: { source: 'context.usage', status: 'denied', value: null } })
  expect(removed?.event).toEqual({ type: 'data:changed', data: { id: 'metrics', snapshot: null } })
  expect(projectExtensionViewEvent(owned, { type: 'private:changed', data: {} } as unknown as ExtensionViewNotification, allowed)).toBeNull()
})
