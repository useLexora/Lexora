import type { RendererDiagnosticReport } from '@buddy-shared/diagnostics/rendererDiagnostic'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRendererDiagnostics } from '../RendererDiagnostics'

const event = { event: 'workbench.contributions.registered', level: 'info', count: 1 } as const
afterEach(() => vi.useRealTimers())

describe('renderer diagnostic delivery', () => {
  it('drains accepted final records and stops accepting new observations during disposal', async () => {
    const accepted = deferred<boolean>()
    const reports: RendererDiagnosticReport[] = []
    const diagnostics = createRendererDiagnostics({ report: (report) => {
      reports.push(report)

      return accepted.promise
    } })
    diagnostics.events.publish(event)
    const closing = diagnostics.dispose()
    diagnostics.events.publish(event)
    await Promise.resolve()
    expect(reports).toHaveLength(1)
    accepted.resolve(true)
    expect(await closing).toEqual({ pending: 0, dropped: 0, failed: 0 })
    expect(reports[0]!.diagnostic.sourceSequence).toBe(1)
  })

  it('bounds pending records and shutdown wait while preserving later loss accounting', async () => {
    vi.useFakeTimers()
    const accepted = deferred<boolean>()
    const diagnostics = createRendererDiagnostics({ report: () => accepted.promise })
    for (let index = 0; index < 130; index++) diagnostics.events.publish(event)
    const flushing = diagnostics.flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await flushing).toEqual({ pending: 128, dropped: 2, failed: 0 })
    accepted.resolve(true)
    expect(await diagnostics.dispose()).toEqual({ pending: 0, dropped: 2, failed: 0 })
  })

  it('keeps one root sequence across scopes and continues after a failed transport', async () => {
    const reports: RendererDiagnosticReport[] = []
    const diagnostics = createRendererDiagnostics({ report: async (report) => {
      reports.push(report)
      if (reports.length === 1)
        throw new Error('fixture-private-transport')
      return true
    } })
    diagnostics.events.publish(event)
    expect(await diagnostics.flush()).toEqual({ pending: 0, dropped: 0, failed: 1 })
    diagnostics.events.scope({}).publish(event)
    expect(await diagnostics.dispose()).toEqual({ pending: 0, dropped: 0, failed: 1 })
    expect(reports.map(report => report.diagnostic.sourceSequence)).toEqual([1, 2])
    expect(new Set(reports.map(report => report.sourceId)).size).toBe(1)
    expect(JSON.stringify(reports)).not.toContain('fixture-private')
  })
})
