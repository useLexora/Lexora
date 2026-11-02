import { describe, expect, it } from 'vitest'
import { lifecycleProgressSchema, rendererLifecycleReportSchema, serviceLifecycleChangeSchema } from '../serviceLifecycle'
import { ServiceLifecycleSource } from '../ServiceLifecycleSource'

describe('lifecycle transport snapshots', () => {
  it('validates progress bounds and keeps counters in revisioned snapshots rather than transition events', () => {
    expect(lifecycleProgressSchema.parse({ completed: 0, total: 0 })).toEqual({ completed: 0, total: 0 })
    for (const progress of [{ completed: -1, total: 3 }, { completed: 4, total: 3 }, { completed: 1.5, total: 3 }, { completed: 1, total: Infinity }])
      expect(lifecycleProgressSchema.safeParse(progress).success).toBe(false)
    const source = new ServiceLifecycleSource()
    source.update({ component: 'runtime.event_replay', kind: 'operation', operationId: 'recovery-1', status: 'starting' })
    source.updateProgress('runtime.event_replay', 'recovery-1', { completed: 2, total: 4 })
    const change = serviceLifecycleChangeSchema.parse({ snapshot: source.reader.snapshot })
    expect(change.snapshot.components[0]?.progress).toEqual({ completed: 2, total: 4 })
    const revision = source.reader.snapshot.revision
    source.updateProgress('runtime.event_replay', 'retired-operation', { completed: 4, total: 4 })
    expect(source.reader.snapshot.revision).toBe(revision)
    source.stopping()
    source.updateProgress('runtime.event_replay', 'recovery-1', { completed: 4, total: 4 })
    expect(source.reader.snapshot.components[0]?.progress).toEqual({ completed: 2, total: 4 })
  })

  it('accepts a complete current snapshot and rejects mismatched changes, duplicate components and diagnostic payloads', () => {
    const source = new ServiceLifecycleSource()
    const component = { component: 'renderer', kind: 'service', operationId: 'renderer-1', status: 'ready' } as const
    source.update(component)
    const change = { snapshot: source.reader.snapshot, component }
    expect(rendererLifecycleReportSchema.parse({ generation: 'runtime-1', change }).change.snapshot.revision).toBe(1)
    expect(serviceLifecycleChangeSchema.safeParse({ ...change, component: { ...component, status: 'start_failed' } }).success).toBe(false)
    expect(serviceLifecycleChangeSchema.safeParse({ ...change, snapshot: { ...change.snapshot, components: [component, component] } }).success).toBe(false)
    expect(rendererLifecycleReportSchema.safeParse({ generation: 'runtime-1', change, payload: { content: 'fixture-private' } }).success).toBe(false)
    expect(serviceLifecycleChangeSchema.safeParse({ event: 'component.ready', level: 'info', component: 'renderer' }).success).toBe(false)
  })
})
