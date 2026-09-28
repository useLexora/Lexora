import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { Event } from '../../../shared/events/Emitter'
import type { EventSubscription } from '../../../shared/events/eventTypes'
import type { SessionDirectoryGrantChange } from '../directories/SessionDirectoryGrants'
import type { SandboxDirectoryPermissionChange } from '../sandbox/SandboxDirectoryPermissions'
import type { ToolExecutionPermissionChange } from './ToolExecutionPermissions'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'

export function observeSessionPermissions(sources: {
  grants: Event<SessionDirectoryGrantChange>
  sandbox: Event<SandboxDirectoryPermissionChange>
  tools: Event<ToolExecutionPermissionChange>
}, conversationId: string, report?: ApplicationDiagnosticReporter): EventSubscription {
  const record = safeDiagnosticReporter(report)
  const subscriptions = [
    sources.grants(event => record({ event: `directory.session.${event.kind}`, level: 'info', conversationId, revision: event.revision, count: event.count })),
    sources.sandbox(event => record({ event: `directory.sandbox.${event.kind}`, level: 'info', conversationId, runId: event.runId, revision: event.revision, count: event.count })),
    sources.tools(event => record({ event: `directory.tool.${event.kind}`, level: 'info', conversationId, runId: event.runId, toolCallId: event.toolCallId, revision: event.revision, count: event.count })),
  ]
  return { dispose: () => subscriptions.forEach(subscription => subscription.dispose()) }
}
