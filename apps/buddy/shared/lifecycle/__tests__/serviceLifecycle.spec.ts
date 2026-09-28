import { describe, expect, it } from 'vitest'
import { rendererLifecycleReportSchema, serviceLifecycleChangeSchema } from '../serviceLifecycle'
import { ServiceLifecycleSource } from '../ServiceLifecycleSource'

describe('lifecycle transport snapshots', () => {
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
