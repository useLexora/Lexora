import type { RendererDiagnosticApi } from '@buddy-shared/diagnostics/rendererDiagnostic'
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
  let dropped = 0
  let failed = 0
  const unsubscribe = events.subscribe((event) => {
    const parsed = rendererDiagnosticSchema.safeParse(event)
    if (!parsed.success) {
      failed++
      return
    }
    if (pending.size >= 128) {
      dropped++
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
