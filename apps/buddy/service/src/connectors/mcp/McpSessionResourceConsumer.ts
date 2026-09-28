import type { ApplicationDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'
import type { EventSubscription } from '../../../../shared/events/eventTypes'
import type { BuddyCapabilityResourceRevision } from '../../agent/extensions/BuddyCapability'
import type { SessionResourceReconciler } from '../../agent/resources/SessionResourceReconciler'
import type { BuddySessionRegistry, DisposableBuddySession } from '../../agent/sessions/BuddySessionRegistry'
import type { McpConnectorService } from './McpConnectorService'
import { safeDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'

export class McpSessionResourceConsumer<TSession extends DisposableBuddySession> {
  readonly #subscriptions: EventSubscription[]
  readonly #service: McpConnectorService
  readonly #sessions: BuddySessionRegistry<TSession>
  readonly #resources: SessionResourceReconciler<TSession>
  readonly #record: ApplicationDiagnosticReporter
  #disposed = false

  constructor(options: { service: McpConnectorService, sessions: BuddySessionRegistry<TSession>, resources: SessionResourceReconciler<TSession>, report?: ApplicationDiagnosticReporter }) {
    this.#service = options.service
    this.#sessions = options.sessions
    this.#resources = options.resources
    this.#record = safeDiagnosticReporter(options.report)
    this.#subscriptions = [
      options.service.onDidChange((event) => {
        if (event.type === 'configuration')
          void this.resync()
      }),
      options.service.onDidChangeConnection((event) => {
        if (event.type === 'generation' || event.type === 'catalog' || event.type === 'availability')
          void this.resync()
      }),
      options.sessions.onDidChange((event) => {
        if (event.type === 'ready')
          void this.resync()
      }),
    ]
    void this.resync()
  }

  async resync(): Promise<void> {
    if (this.#disposed)
      return
    const revision = resourceKey(this.#service.resourceRevisions())
    const sessionIds = this.#sessions.snapshot().filter(session => session.status === 'ready' && !session.invalidationPending && resourceKey(session.resourceRevisions.filter(resource => resource.source === 'connector')) !== revision).map(session => session.id)
    if (!sessionIds.length)
      return
    try {
      await this.#resources.reconcileInvalidation({ source: 'connector', scope: this.#service.sourceId, revision, sessionIds, matches: () => true, retry: true })
    }
    catch {
      this.#record({ event: 'connectors.sessions.reconciliation_failed', level: 'warn', errorCode: 'MCP_SESSION_RECONCILIATION_FAILED' })
    }
  }

  whenIdle(): Promise<void> {
    return this.#resources.whenIdle()
  }

  async dispose(): Promise<void> {
    await this.#service.quiesce()
    await this.whenIdle()
    this.#disposed = true
    for (const subscription of this.#subscriptions)
      subscription.dispose()
  }
}

function resourceKey(resources: readonly BuddyCapabilityResourceRevision[]): string {
  return JSON.stringify([...resources].sort((left, right) => left.id.localeCompare(right.id)))
}
