import type { DesktopDiagnosticLogger } from '../desktopDiagnostics'
import process from 'node:process'

const reported = new WeakSet<DesktopDiagnosticLogger>()

export async function closeDesktopDiagnostics(logger: DesktopDiagnosticLogger): Promise<void> {
  const status = await logger.close()
  if (reported.has(logger) || (!status.dropped && !status.failed && !status.unconfirmed && !status.closeTimedOut && !status.lastError))
    return
  reported.add(logger)
  try {
    process.stderr.write(`${JSON.stringify({ event: 'recorder.close_incomplete', dropped: status.dropped, failed: status.failed, unconfirmed: status.unconfirmed, closeTimedOut: status.closeTimedOut, ioFailed: status.lastError !== null })}\n`)
  }
  catch {}
}
