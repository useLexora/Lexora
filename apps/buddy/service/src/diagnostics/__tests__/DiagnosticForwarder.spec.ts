import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticForwarder } from '../DiagnosticForwarder'

beforeEach(() => vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

describe('diagnostic transport budget', () => {
  it('bounds a producer storm and reports cumulative loss during idle without replaying suppressed events', () => {
    const records: ApplicationDiagnostic[] = []
    const source = new DiagnosticForwarder(event => records.push(event))
    for (let index = 0; index < 10000; index++)
      source.record({ event: 'tool.started', level: 'info', count: index })
    expect(records).toHaveLength(512)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(4999)
    expect(records).toHaveLength(512)
    vi.advanceTimersByTime(1)
    expect(records.at(-1)).toMatchObject({ event: 'recorder.loss', recorderLoss: { dropped: 9488, failed: 0 } })
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(30000)
    source.record({ event: 'tool.completed', level: 'info' })
    expect(records.at(-1)?.event).toBe('tool.completed')
    expect(new Set(records.map(event => event.producerInstanceId)).size).toBe(1)
    source.dispose()
    expect(records).toHaveLength(514)
  })

  it('isolates a failed transport and exposes its loss after recovery', () => {
    let failed = true
    const records: ApplicationDiagnostic[] = []
    const source = new DiagnosticForwarder((event) => {
      if (failed)
        throw new Error('private transport context')
      records.push(event)
    })
    expect(() => source.record({ event: 'tool.started', level: 'info' })).not.toThrow()
    vi.advanceTimersByTime(5000)
    expect(records).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    failed = false
    vi.advanceTimersByTime(5000)
    expect(records[0]?.recorderLoss).toEqual({ dropped: 0, failed: 2 })
    expect(vi.getTimerCount()).toBe(0)
    expect(JSON.stringify(records)).not.toContain('private')
    source.dispose()
  })

  it('flushes remaining losses once on shutdown and stops subsequent delivery and retries', () => {
    const records: ApplicationDiagnostic[] = []
    const source = new DiagnosticForwarder(event => records.push(event))
    for (let index = 0; index < 513; index++)
      source.record({ event: 'tool.started', level: 'info' })
    source.dispose()
    expect(records.at(-1)?.recorderLoss).toEqual({ dropped: 1, failed: 0 })
    expect(vi.getTimerCount()).toBe(0)
    source.dispose()
    source.record({ event: 'tool.completed', level: 'info' })
    vi.advanceTimersByTime(10000)
    expect(records).toHaveLength(513)

    const broken = new DiagnosticForwarder(() => {
      throw new Error('transport closed')
    })
    broken.record({ event: 'tool.started', level: 'info' })
    broken.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
