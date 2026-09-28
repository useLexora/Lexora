import type { LifecycleFailure } from '../lifecycle/lifecycleFailure'
import { z } from 'zod'
import { extensionIdSchema } from '../extensions/extensionManifest'
import { readLifecycleFailure } from '../lifecycle/lifecycleFailure'
import { desktopBootstrapFailureSchema, processExitSchema, rendererLoadFailureSchema } from './desktopStartupDiagnostic'
import { networkStartupFailureSchema } from './networkStartupFailure'
import { privateDirectoryFailureSchema } from './privateDirectoryFailure'
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
  producerInstanceId: z.uuid().optional(),
  extensionId: extensionIdSchema.optional(),
  workingCopyId: z.uuid().optional(),
  markId: z.uuid().optional(),
  revision: z.number().int().nonnegative().optional(),
  contentVersion: z.number().int().nonnegative().optional(),
  savedVersion: z.number().int().nonnegative().optional(),
  dirty: z.boolean().optional(),
  generation: diagnosticIdentitySchema.optional(),
  sessionId: diagnosticIdentitySchema.optional(),
  providerId: diagnosticIdentitySchema.optional(),
  connectorId: diagnosticIdentitySchema.optional(),
  automationId: diagnosticIdentitySchema.optional(),
  occurrenceId: diagnosticIdentitySchema.optional(),
  toolCallId: diagnosticIdentitySchema.optional(),
  conversationId: diagnosticIdentitySchema.optional(),
  spaceId: diagnosticIdentitySchema.optional(),
  directoryId: diagnosticIdentitySchema.optional(),
  branchId: diagnosticIdentitySchema.optional(),
  runId: diagnosticIdentitySchema.optional(),
  turnId: diagnosticIdentitySchema.optional(),
  requestId: diagnosticIdentitySchema.optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  errorCode: diagnosticCodeSchema.optional(),
  errorType: z.string().regex(/^[a-z]\w{0,95}$/i).optional(),
  failure: z.union([privateDirectoryFailureSchema, desktopBootstrapFailureSchema, networkStartupFailureSchema]).optional(),
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
export type DiagnosticError = LifecycleFailure

export function safeDiagnosticReporter(report?: ApplicationDiagnosticReporter): ApplicationDiagnosticReporter {
  return (event) => {
    try {
      report?.(event)
    }
    catch {}
  }
}

export const readDiagnosticError = readLifecycleFailure

export function readDiagnosticErrorCode(error: unknown): string {
  return readDiagnosticError(error).errorCode ?? 'OPERATION_FAILED'
}
