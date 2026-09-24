import { z } from 'zod'
import { readLocalChatErrorCode } from '../runtime/localChatError'
import { desktopBootstrapFailureSchema, processExitSchema, rendererLoadFailureSchema } from './desktopStartupDiagnostic'
import { privateDirectoryErrorCodeSchema, privateDirectoryFailureSchema } from './privateDirectoryFailure'
import { providerRequestDiagnosticSchema } from './providerRequestDiagnostic'

export const APPLICATION_DIAGNOSTIC_METHOD = 'application.diagnostic'
export const diagnosticIdentitySchema = z.string().regex(/^\w[\w:.-]{0,191}$/)
export const diagnosticCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/)

export const applicationDiagnosticSchema = z.object({
  event: z.string().regex(/^[a-z][a-z\d._-]{0,95}$/),
  component: z.string().regex(/^[a-z][a-z\d._-]{0,95}$/).optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  operationId: diagnosticIdentitySchema.optional(),
  parentOperationId: diagnosticIdentitySchema.optional(),
  generation: diagnosticIdentitySchema.optional(),
  sessionId: diagnosticIdentitySchema.optional(),
  providerId: diagnosticIdentitySchema.optional(),
  connectorId: diagnosticIdentitySchema.optional(),
  automationId: diagnosticIdentitySchema.optional(),
  occurrenceId: diagnosticIdentitySchema.optional(),
  toolCallId: diagnosticIdentitySchema.optional(),
  conversationId: diagnosticIdentitySchema.optional(),
  branchId: diagnosticIdentitySchema.optional(),
  runId: diagnosticIdentitySchema.optional(),
  turnId: diagnosticIdentitySchema.optional(),
  requestId: diagnosticIdentitySchema.optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  errorCode: diagnosticCodeSchema.optional(),
  errorType: z.string().regex(/^[a-z]\w{0,95}$/i).optional(),
  failure: z.union([privateDirectoryFailureSchema, desktopBootstrapFailureSchema]).optional(),
  providerRequest: providerRequestDiagnosticSchema.optional(),
  recorderLoss: z.object({ dropped: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict().optional(),
  processExit: processExitSchema.optional(),
  loadFailure: rendererLoadFailureSchema.optional(),
  recoveryAction: z.enum(['retry', 'open_logs', 'export_diagnostics', 'copy_details', 'show_directory', 'quit']).optional(),
  previousLaunchId: z.uuid().optional(),
  count: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().optional(),
  method: z.string().regex(/^[a-z][a-z\d.]{0,95}$/i).optional(),
  sourceSequence: z.number().int().positive().optional(),
  occurredAt: z.iso.datetime().optional(),
}).strict()

export type ApplicationDiagnostic = z.infer<typeof applicationDiagnosticSchema>
export type ApplicationDiagnosticReporter = (event: ApplicationDiagnostic) => void
export type DiagnosticError = Pick<ApplicationDiagnostic, 'errorCode' | 'errorType' | 'failure'>

export function safeDiagnosticReporter(report?: ApplicationDiagnosticReporter): ApplicationDiagnosticReporter {
  return (event) => {
    try {
      report?.(event)
    }
    catch {}
  }
}

export function readDiagnosticErrorCode(error: unknown): string {
  return readDiagnosticError(error).errorCode ?? 'OPERATION_FAILED'
}

export function readDiagnosticError(error: unknown): DiagnosticError {
  let errorCode: string | null = readLocalChatErrorCode(error)
  let failure: ApplicationDiagnostic['failure']
  const visited = new Set<object>()
  for (let current = error; current && typeof current === 'object' && visited.size < 8 && !visited.has(current); current = 'cause' in current ? current.cause : undefined) {
    visited.add(current)
    const code = 'code' in current ? current.code : undefined
    const privateDirectoryCode = privateDirectoryErrorCodeSchema.safeParse(code)
    if (!errorCode) {
      if (privateDirectoryCode.success)
        errorCode = privateDirectoryCode.data
      else if (typeof code === 'string' && ['DESKTOP_BOOTSTRAP_FAILED', 'INITIAL_STATE_UNAVAILABLE', 'POWERSHELL_UNAVAILABLE', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EMFILE', 'ERR_SQLITE_ERROR'].includes(code))
        errorCode = code
    }
    if (!failure && (privateDirectoryCode.success || code === 'DESKTOP_BOOTSTRAP_FAILED')) {
      const schema = privateDirectoryCode.success ? privateDirectoryFailureSchema : desktopBootstrapFailureSchema
      const parsed = schema.safeParse('failure' in current ? current.failure : undefined)
      if (parsed.success)
        failure = parsed.data
    }
  }
  const errorType = applicationDiagnosticSchema.shape.errorType.safeParse(error instanceof Error ? error.name : 'UnknownError')
  return {
    errorCode: errorCode ?? 'OPERATION_FAILED',
    errorType: errorType.success ? errorType.data : 'UnknownError',
    ...(failure ? { failure } : {}),
  }
}
