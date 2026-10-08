import type { RendererDiagnostic } from '@buddy-shared/diagnostics/rendererDiagnostic'
import type { ApplicationEvents } from '@buddy-shared/observability/ApplicationEvents'
import type { WorkbenchController, WorkbenchLayoutChange } from '@/workbench/services/WorkbenchController'
import type { WorkingCopyChangeKind, WorkingCopyService } from '@/workbench/services/WorkingCopyService'

const copyEvents = {
  'registered': 'registered',
  'restored': 'restored',
  'released': 'released',
  'load-started': 'load_started',
  'loaded': 'loaded',
  'load-failed': 'load_failed',
  'edited': 'dirty_changed',
  'save-started': 'save_started',
  'saved': 'saved',
  'save-conflict': 'save_conflict',
  'save-failed': 'save_failed',
  'conflict-resolved': 'conflict_resolved',
  'discarded': 'discarded',
} as const satisfies Record<Exclude<WorkingCopyChangeKind, 'access-changed'>, string>

const layoutEvents = {
  'opened': 'workbench.layout.opened',
  'moved': 'workbench.layout.moved',
  'closed': 'workbench.layout.closed',
  'restored': 'workbench.layout.restored',
  'interaction-removed': 'workbench.layout.interaction_removed',
} as const satisfies Partial<Record<WorkbenchLayoutChange['kind'], RendererDiagnostic['event']>>

export class WorkbenchDiagnostics {
  readonly #subscriptions

  constructor({ controller, copies, events }: { controller: WorkbenchController, copies: WorkingCopyService, events: ApplicationEvents }) {
    this.#subscriptions = [
      copies.onDidChange((change) => {
        if (change.kind === 'access-changed')
          return
        if (change.kind === 'edited' && change.copy.dirty === change.previous?.dirty)
          return
        events.publish({
          event: `workbench.copy.${copyEvents[change.kind]}`,
          level: change.kind.endsWith('failed') ? 'error' : change.kind === 'save-conflict' ? 'warn' : 'info',
          workingCopyId: change.copy.incarnation,
          revision: change.revision,
          contentVersion: change.copy.contentVersion,
          savedVersion: change.copy.savedVersion,
          dirty: change.copy.dirty,
          ...(change.operationId ? { operationId: change.operationId } : {}),
        })
      }),
      controller.commands.onDidExecute(change => events.publish({
        event: `workbench.command.${change.stage}`,
        level: change.stage === 'failed' ? 'error' : 'info',
        operationId: change.operationId,
        ...(change.durationMs === undefined ? {} : { durationMs: change.durationMs }),
      })),
      controller.registry.onDidChange(change => events.publish({
        event: `workbench.contributions.${change.kind}`,
        level: 'info',
        revision: change.revision,
        count: Object.values(change.ids).reduce((total, ids) => total + ids.length, 0),
      })),
      controller.onDidChangeLayout((change) => {
        const event = layoutEvents[change.kind as keyof typeof layoutEvents]
        if (event)
          events.publish({ event, level: 'info', revision: change.revision, count: new Set([...change.changedViewIds, ...change.removedViewIds]).size })
      }),
      controller.onDidSettleClose((result) => {
        if (result.committed)
          events.publish({ event: result.status === 'closed' ? 'workbench.close.closed' : 'workbench.close.cleanup_pending', level: result.failures.length ? 'warn' : 'info', revision: result.revision, count: result.failures.length || result.views.length })
      }),
    ]
  }

  dispose(): void {
    for (const subscription of this.#subscriptions)
      subscription.dispose()
  }
}
