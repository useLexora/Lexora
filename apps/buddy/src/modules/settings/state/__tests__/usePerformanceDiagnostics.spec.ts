// @vitest-environment jsdom
import type { CpuProfileSummary, PerformanceDiagnosticApi } from '@buddy-shared/diagnostics/performanceDiagnostic'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { usePerformanceDiagnostics } from '../usePerformanceDiagnostics'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function mount(api: PerformanceDiagnosticApi) {
  const root = document.createElement('div')
  document.body.append(root)
  let state!: ReturnType<typeof usePerformanceDiagnostics>
  const app = createApp({ setup() {
    state = usePerformanceDiagnostics(api)
    return () => null
  } })
  app.mount(root)
  let disposed = false
  const dispose = () => {
    if (disposed)
      return
    disposed = true
    app.unmount()
    root.remove()
  }
  cleanups.push(dispose)
  return { state, dispose }
}

it('stops polling and ignores pending snapshots and profiles when the dialog closes', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const snapshot = deferred<Awaited<ReturnType<PerformanceDiagnosticApi['snapshot']>>>()
  const profile = deferred<CpuProfileSummary>()
  const { state, dispose } = mount({ snapshot: () => snapshot.promise, capture: () => profile.promise })
  const analyzing = state.capture({ target: 'runtime', pid: 42 })
  expect(state.capturing.value).toEqual({ target: 'runtime', pid: 42 })
  expect(state.reading.value).toBe(true)
  dispose()
  snapshot.resolve({ samples: [], coverage: 'electron-processes', intervalMs: 5000, rendererPid: 17 })
  profile.resolve({ target: 'runtime', pid: 42, durationMs: 5000, samples: 1, hotspots: [] })
  await analyzing
  await vi.advanceTimersByTimeAsync(15000)
  expect(state.rendererPid.value).toBeNull()
  expect(state.profile.value).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps snapshot availability separate from manual analysis failures and allows retry', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const api: PerformanceDiagnosticApi = {
    snapshot: async () => ({ samples: [], coverage: 'electron-processes', intervalMs: 5000, rendererPid: 17 }),
    capture: async () => { throw new Error('CPU_PROFILE_PROCESS_CHANGED') },
  }
  const { state } = mount(api)
  await expect(state.capture({ target: 'runtime', pid: 42 })).rejects.toThrow('CPU_PROFILE_PROCESS_CHANGED')
  expect(state.capturing.value).toBeNull()
  expect(state.unavailable.value).toBe(false)
  api.capture = async request => ({ ...request, durationMs: 5000, samples: 1, hotspots: [] })
  await state.capture({ target: 'runtime', pid: 43 })
  expect(state.profile.value).toMatchObject({ target: 'runtime', pid: 43, samples: 1 })
})
