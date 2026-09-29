import type { CpuProfileRequest, CpuProfileSummary, PerformanceDiagnosticApi, PerformanceSample } from '@buddy-shared/diagnostics/performanceDiagnostic'
import { onMounted, onScopeDispose, shallowRef } from 'vue'

export function usePerformanceDiagnostics(api: PerformanceDiagnosticApi) {
  const sample = shallowRef<PerformanceSample | null>(null)
  const rendererPid = shallowRef<number | null>(null)
  const profile = shallowRef<CpuProfileSummary | null>(null)
  const capturing = shallowRef<CpuProfileRequest | null>(null)
  const unavailable = shallowRef(false)
  const reading = shallowRef(false)
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined

  async function refresh(): Promise<void> {
    if (reading.value || disposed || document.hidden)
      return
    reading.value = true
    try {
      const snapshot = await api.snapshot()
      if (!disposed) {
        sample.value = snapshot.samples.at(-1) ?? null
        rendererPid.value = snapshot.rendererPid
        unavailable.value = false
      }
    }
    catch {
      if (!disposed)
        unavailable.value = true
    }
    finally {
      if (!disposed)
        reading.value = false
    }
  }

  async function capture(request: CpuProfileRequest): Promise<void> {
    if (capturing.value || disposed)
      return
    capturing.value = request
    profile.value = null
    try {
      const result = await api.capture(request)
      if (!disposed)
        profile.value = result
    }
    catch (error) {
      if (!disposed)
        throw error
    }
    finally {
      if (!disposed)
        capturing.value = null
    }
  }

  onMounted(() => {
    void refresh()
    timer = setInterval(() => void refresh(), 5000)
  })
  onScopeDispose(() => {
    disposed = true
    clearInterval(timer)
  })
  return { sample, rendererPid, profile, capturing, unavailable, reading, refresh, capture }
}
