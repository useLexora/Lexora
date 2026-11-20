import type { ApplicationDiagnostic } from '../../shared/diagnostics/applicationDiagnostic'

export function writePlatformHostDiagnostic(event: ApplicationDiagnostic & {
  hostPid?: number
  previousGeneration?: string
  exit?: { code: number | null, signal: NodeJS.Signals | null }
}): void {
  try {
    console.error(JSON.stringify({ occurredAt: new Date().toISOString(), ...event }))
  }
  catch {}
}
