import type { ApplicationDiagnostic } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ApplicationLogRecord } from '../../../shared/diagnostics/applicationLog'
import { Buffer } from 'node:buffer'
import { applicationDiagnosticSchema } from '../../../shared/diagnostics/applicationDiagnostic'

export const MAX_DIAGNOSTIC_RECORD_BYTES = 16 * 1024
export type DesktopDiagnosticScope = 'desktop' | 'local-service' | 'native-pet'
export type DesktopDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DesktopDiagnosticEvent extends ApplicationDiagnostic {
  scope: DesktopDiagnosticScope
  level: DesktopDiagnosticLevel
  event: string
  message?: string
  sourceId?: string
  sourcePid?: number
  operationId?: string
  durationMs?: number
  error?: unknown
}

export interface DiagnosticContext {
  appVersion: string
  launchId: string
  collectorPid: number
  platform: string
}

export type DesktopDiagnosticRecord = ApplicationLogRecord

export function encodeDiagnosticRecord(
  input: DesktopDiagnosticEvent,
  context: DiagnosticContext,
  sequence: number,
  elapsedMs: number,
  userHome: string,
): Buffer | null {
  const clean = (value: string) => {
    if (value.length > MAX_DIAGNOSTIC_RECORD_BYTES)
      throw new RangeError('Diagnostic field exceeds the record limit')
    return redactDiagnosticText(value, userHome)
  }
  try {
    if (!/^[a-z][a-z\d._-]{0,95}$/.test(input.event))
      return null
    const error = input.error instanceof Error ? input.error : undefined
    const record: DesktopDiagnosticRecord = {
      ...context,
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round(elapsedMs),
      sequence,
      scope: input.scope,
      level: input.level,
      event: input.event,
      message: input.message === undefined ? undefined : clean(input.message),
      sourceId: input.sourceId === undefined ? undefined : clean(input.sourceId),
      sourcePid: typeof input.sourcePid === 'number' && Number.isSafeInteger(input.sourcePid) && input.sourcePid > 0 ? input.sourcePid : undefined,
      operationId: input.operationId === undefined ? undefined : clean(input.operationId),
      durationMs: typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0 ? input.durationMs : undefined,
      error: error
        ? {
            name: clean(error.name),
            message: clean(error.message),
            stack: error.stack === undefined ? undefined : clean(error.stack),
            code: 'code' in error && typeof error.code === 'string' ? clean(error.code) : undefined,
          }
        : input.error === undefined ? undefined : { name: 'UnknownError', message: 'Non-Error failure' },
    }
    for (const key of ['parentOperationId', 'generation', 'sessionId', 'providerId', 'connectorId', 'automationId', 'occurrenceId', 'toolCallId', 'sourceSequence', 'occurredAt', 'component', 'conversationId', 'branchId', 'runId', 'turnId', 'requestId', 'errorCode', 'errorType', 'failure', 'providerRequest', 'recorderLoss', 'processExit', 'loadFailure', 'recoveryAction', 'previousLaunchId', 'count', 'attempt', 'method'] as const) {
      const parsed = applicationDiagnosticSchema.shape[key].safeParse(input[key])
      if (!parsed.success)
        return null
      if (parsed.data !== undefined)
        Object.assign(record, { [key]: typeof parsed.data === 'string' ? clean(parsed.data) : parsed.data })
    }
    const line = Buffer.from(`${JSON.stringify(record)}\n`)
    return line.length <= MAX_DIAGNOSTIC_RECORD_BYTES ? line : null
  }
  catch {
    return null
  }
}

export function redactDiagnosticText(value: string, userHome: string): string {
  let text = value
  if (userHome) {
    const windowsHome = /^[a-z]:[/\\]/i.test(userHome)
    const pattern = userHome.split(/[/\\]/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[/\\\\]')
    text = windowsHome ? text.replace(new RegExp(pattern, 'gi'), '<home>') : text.replaceAll(userHome, '<home>')
  }
  return text
    .replace(/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^\s"',;}]+/gi, '$1<redacted>')
    .replace(/\b((?:set-cookie|cookie)["']?\s*[:=])[^\r\n]+/gi, '$1 <redacted>')
    .replace(/\b((?:[\w-]*(?:token|secret|password)|api[_-]?key|credential|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi, '$1<redacted>')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;}]+/gi, '$1 <redacted>')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1<redacted>@')
    .replace(/\b(?:sk|key)-[\w-]+/gi, '<redacted>')
}
