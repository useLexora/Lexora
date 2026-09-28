import { z } from 'zod'
import { applicationDiagnosticSchema } from './applicationDiagnostic'

export const rendererDiagnosticSchema = applicationDiagnosticSchema.pick({
  level: true,
  operationId: true,
  workingCopyId: true,
  revision: true,
  contentVersion: true,
  savedVersion: true,
  dirty: true,
  durationMs: true,
  count: true,
}).extend({
  event: z.enum([
    'workbench.copy.registered',
    'workbench.copy.restored',
    'workbench.copy.released',
    'workbench.copy.load_started',
    'workbench.copy.loaded',
    'workbench.copy.load_failed',
    'workbench.copy.dirty_changed',
    'workbench.copy.save_started',
    'workbench.copy.saved',
    'workbench.copy.save_conflict',
    'workbench.copy.save_failed',
    'workbench.copy.conflict_resolved',
    'workbench.copy.discarded',
    'workbench.command.started',
    'workbench.command.completed',
    'workbench.command.failed',
    'workbench.layout.opened',
    'workbench.layout.moved',
    'workbench.layout.closed',
    'workbench.layout.restored',
    'workbench.layout.interaction_removed',
    'workbench.close.closed',
    'workbench.close.cleanup_pending',
    'workbench.contributions.registered',
    'workbench.contributions.removed',
  ]),
  operationId: z.uuid().optional(),
  sourceSequence: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
}).strict()

export const rendererDiagnosticReportSchema = z.object({
  sourceId: z.uuid(),
  diagnostic: rendererDiagnosticSchema,
}).strict()

export type RendererDiagnostic = z.infer<typeof rendererDiagnosticSchema>
export type RendererDiagnosticReport = z.infer<typeof rendererDiagnosticReportSchema>
export interface RendererDiagnosticApi {
  report: (input: RendererDiagnosticReport) => Promise<boolean>
}
