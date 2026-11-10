import type { Readable } from 'node:stream'
import type { ApplicationDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import { Buffer } from 'node:buffer'
import { safeDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import { DiagnosticAdmission } from '../../shared/diagnostics/DiagnosticAdmission'
import { inferenceStderrDiagnosticSchema } from '../../shared/diagnostics/inferenceDiagnostic'

const MAX_LINE_BYTES = 8 * 1024

export function observeInferenceDiagnostics(stream: Readable, extensionId: string, instanceId: string, report?: ApplicationDiagnosticReporter): void {
  if (!report) {
    stream.resume()
    return
  }
  const record = safeDiagnosticReporter(report)
  const admission = new DiagnosticAdmission()
  let pending = Buffer.alloc(0)
  let oversized = false
  const flush = () => {
    if (!oversized && pending.length && admission.take()) {
      try {
        const parsed = inferenceStderrDiagnosticSchema.safeParse(JSON.parse(pending.toString('utf8')))
        if (parsed.success) {
          const { event, id, code, ...inference } = parsed.data
          const errorCode = typeof code === 'string' ? code : inference.error
          record({
            event,
            component: 'models.inference',
            level: event === 'chat.gpu.error' ? 'error' : inference.degraded || (event === 'chat.gpu.exit' && code !== 0 && code !== null) ? 'warn' : 'info',
            extensionId,
            operationId: instanceId,
            ...(id ? { requestId: id } : {}),
            ...(errorCode ? { errorCode } : {}),
            inference,
          })
        }
      }
      catch {}
    }
    pending = Buffer.alloc(0)
    oversized = false
  }
  stream.on('data', (chunk: Buffer) => {
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      if (!oversized) {
        if (pending.length + end - offset > MAX_LINE_BYTES) {
          oversized = true
          pending = Buffer.alloc(0)
        }
        else {
          pending = Buffer.concat([pending, chunk.subarray(offset, end)])
        }
      }
      if (newline < 0)
        break
      flush()
      offset = newline + 1
    }
  })
  stream.once('end', flush)
}
