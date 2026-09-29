import type { RendererDiagnosticApi } from '@buddy-shared/diagnostics/rendererDiagnostic'
import { DiagnosticAdmission } from '@buddy-shared/diagnostics/DiagnosticAdmission'
import { rendererDiagnosticSchema } from '@buddy-shared/diagnostics/rendererDiagnostic'
import { ApplicationEvents } from '@buddy-shared/observability/ApplicationEvents'

export interface RendererDiagnosticStatus {
  pending: number
  dropped: number
  failed: number
}

export function createRendererDiagnostics(api: RendererDiagnosticApi) {
  const events = new ApplicationEvents()
  const sourceId = crypto.randomUUID()
  const pending = new Set<Promise<void>>()
  const admission = new DiagnosticAdmission()
  let dropped = 0
  let failed = 0
  const unsubscribe = events.subscribe((event) => {
    if (pending.size >= 128 || !admission.take()) {
      dropped++
      return
    }
    const parsed = rendererDiagnosticSchema.safeParse(event)
    if (!parsed.success) {
      failed++
      return
    }
    const delivery = Promise.resolve()
      .then(() => api.report({ sourceId, diagnostic: parsed.data }))
      .then((accepted) => {
        if (!accepted)
          failed++
      }, () => { failed++ })
      .finally(() => pending.delete(delivery))
    pending.add(delivery)
  })
  const flush = async (): Promise<RendererDiagnosticStatus> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000) }),
      ])
    }
    finally { clearTimeout(timer) }
    return { pending: pending.size, dropped, failed }
  }
  return {
    events,
    flush,
    dispose: async (): Promise<RendererDiagnosticStatus> => {
      unsubscribe()
      return flush()
    },
  }
}
