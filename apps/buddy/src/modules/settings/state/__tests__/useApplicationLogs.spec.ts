import type { ApplicationLogExportResult, ApplicationLogPage, ApplicationLogQuery, ApplicationLogRecord } from '@buddy-shared/diagnostics/applicationLog'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { useApplicationLogs } from '../useApplicationLogs'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

function page(sequence: number, pageNumber = 1, total = 500, anchorSequence = sequence): ApplicationLogPage {
  const record: ApplicationLogRecord = { schemaVersion: 1, timestamp: '2026-09-09T00:00:00.000Z', elapsedMs: sequence, sequence, launchId: 'launch-1', appVersion: '0.3.0', platform: 'linux', collectorPid: 42, scope: 'desktop', level: 'info', event: 'app.ready' }
  return { records: [record], launches: [], currentLaunchId: 'launch-1', page: pageNumber, pageSize: 100, total, anchor: { launchId: 'launch-1', sequence: anchorSequence }, anchorExpired: false, skippedRecords: 0 }
}

function fixture() {
  vi.useFakeTimers()
  const requests: { input: ApplicationLogQuery, response: ReturnType<typeof deferred<ApplicationLogPage>> }[] = []
  const scope = effectScope()
  const exportResult = deferred<ApplicationLogExportResult>()
  const exportDiagnostics = vi.fn(() => exportResult.promise)
  const logs = scope.run(() => useApplicationLogs({ query: (input) => {
    const response = deferred<ApplicationLogPage>()
    requests.push({ input, response })
    return response.promise
  }, exportDiagnostics }))!
  cleanups.push(() => scope.stop())
  return { logs, requests, scope, exportDiagnostics, exportResult }
}

describe('application log browsing', () => {
  it('ignores a previous filter response and debounces search', async () => {
    const { logs, requests } = fixture()
    logs.category.value = 'models'
    await nextTick()
    requests[1]!.response.resolve(page(2))
    await logs.refresh()
    requests[0]!.response.resolve(page(1))
    await Promise.resolve()
    expect(logs.page.value?.records[0]?.sequence).toBe(2)
    logs.search.value = ' run-1 '
    await nextTick()
    await vi.advanceTimersByTimeAsync(249)
    expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests[2]?.input).toMatchObject({ category: 'models', search: 'run-1' })
  })

  it('freezes the selected row even when an earlier live poll finishes after selection', async () => {
    const { logs, requests } = fixture()
    requests[0]!.response.resolve(page(1))
    await logs.refresh()
    await vi.advanceTimersByTimeAsync(2000)
    logs.select(logs.page.value!.records[0]!)
    requests[1]!.response.resolve(page(2))
    await Promise.resolve()
    expect(logs.page.value?.records[0]?.sequence).toBe(1)
    expect(logs.selected.value?.sequence).toBe(1)
    expect(logs.live.value).toBe(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(requests).toHaveLength(2)
    logs.follow()
    requests[2]!.response.resolve(page(3))
    await logs.refresh()
    expect(logs.page.value?.records[0]?.sequence).toBe(3)
    expect(logs.selected.value).toBeNull()
    expect(logs.live.value).toBe(true)
  })

  it('preserves reading position while paused and resets the viewport when following again', async () => {
    const { logs, requests } = fixture()
    requests[0]!.response.resolve(page(100))
    await logs.refresh()
    const firstView = logs.viewKey.value
    logs.changePage(4)
    expect(requests[1]?.input).toMatchObject({ page: 4, anchor: { launchId: 'launch-1', sequence: 100 } })
    requests[1]!.response.resolve(page(50, 4, 500, 100))
    await logs.refresh()
    expect(logs.live.value).toBe(false)
    expect(logs.viewKey.value).toBeGreaterThan(firstView)
    logs.changePage(1)
    expect(requests[2]?.input).toMatchObject({ page: 1, anchor: { launchId: 'launch-1', sequence: 100 } })
    requests[2]!.response.resolve(page(100))
    await logs.refresh()
    const pausedView = logs.viewKey.value
    logs.follow()
    expect(logs.viewKey.value).toBeGreaterThan(pausedView)
    expect(requests[3]?.input).toMatchObject({ page: 1, anchor: undefined })
  })

  it('resets page and anchor on filtering and accepts the filtered total', async () => {
    const { logs, requests } = fixture()
    requests[0]!.response.resolve(page(100))
    await logs.refresh()
    logs.changePage(3)
    requests[1]!.response.resolve(page(50, 3, 500, 100))
    await logs.refresh()
    logs.level.value = 'error'
    await nextTick()
    expect(requests[2]?.input).toMatchObject({ page: 1, level: 'error', anchor: undefined })
    requests[2]!.response.resolve(page(25, 1, 3))
    await logs.refresh()
    expect(logs.page.value).toMatchObject({ page: 1, total: 3 })
  })

  it('retains previously read records on a read failure and recovers on refresh', async () => {
    const { logs, requests } = fixture()
    requests[0]!.response.resolve(page(1))
    await logs.refresh()
    const failed = logs.refresh()
    requests[1]!.response.reject(new Error('read failed'))
    await failed
    expect(logs.failed.value).toBe(true)
    expect(logs.page.value?.records[0]?.sequence).toBe(1)
    const retry = logs.refresh()
    requests[2]!.response.resolve(page(2))
    await retry
    expect(logs.failed.value).toBe(false)
    expect(logs.page.value?.records[0]?.sequence).toBe(2)
  })

  it('stops polling and discards pending results when leaving the page', async () => {
    const { logs, requests, scope } = fixture()
    scope.stop()
    requests[0]!.response.resolve(page(1))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(6000)
    expect(logs.page.value).toBeNull()
    expect(requests).toHaveLength(1)
  })

  it('exports the selected launch independently of browsing filters and prevents duplicate exports', async () => {
    const { logs, exportDiagnostics, exportResult } = fixture()
    logs.launch.value = 'launch-history'
    logs.category.value = 'models'
    logs.search.value = 'no-match'
    const pending = logs.exportDiagnostics()
    expect(exportDiagnostics).toHaveBeenCalledExactlyOnceWith({ launch: 'launch-history' })
    expect(logs.exporting.value).toBe(true)
    await expect(logs.exportDiagnostics()).resolves.toEqual({ status: 'canceled' })
    exportResult.resolve({ status: 'saved', errorCount: 2, contextCount: 10 })
    await expect(pending).resolves.toEqual({ status: 'saved', errorCount: 2, contextCount: 10 })
    expect(logs.exporting.value).toBe(false)
  })

  it.each(['empty', 'canceled'] as const)('preserves an export %s outcome without reporting success', async (status) => {
    const { logs, exportResult } = fixture()
    const pending = logs.exportDiagnostics()
    exportResult.resolve({ status })
    await expect(pending).resolves.toEqual({ status })
    expect(logs.exporting.value).toBe(false)
  })

  it('allows retry after a failed export', async () => {
    const { logs, exportDiagnostics, exportResult } = fixture()
    const pending = logs.exportDiagnostics()
    exportResult.reject(new Error('export failed'))
    await expect(pending).rejects.toThrow('export failed')
    expect(logs.exporting.value).toBe(false)
    exportDiagnostics.mockResolvedValueOnce({ status: 'saved', errorCount: 1, contextCount: 1 })
    await expect(logs.exportDiagnostics()).resolves.toMatchObject({ status: 'saved' })
  })

  it.each(['resolve', 'reject'] as const)('discards a late export %s outcome after leaving the page', async (outcome) => {
    const { logs, scope, exportResult } = fixture()
    const pending = logs.exportDiagnostics()
    scope.stop()
    if (outcome === 'resolve')
      exportResult.resolve({ status: 'saved', errorCount: 1, contextCount: 1 })
    else
      exportResult.reject(new Error('late failure'))
    await expect(pending).resolves.toEqual({ status: 'canceled' })
  })
})
