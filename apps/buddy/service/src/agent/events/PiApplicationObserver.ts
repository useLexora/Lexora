import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { ApplicationDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'
import { createHash } from 'node:crypto'
import { diagnosticIdentitySchema } from '../../../../shared/diagnostics/applicationDiagnostic'
import { ApplicationEvents } from '../../../../shared/observability/ApplicationEvents'
import { isToolFailureCode } from '../../../../shared/runs/toolFailure'
import { INFERRED_STREAM_COMPLETION } from '../../providers/withProviderStream'

export class PiApplicationObserver {
  readonly #events: ApplicationEvents
  readonly #runId: string
  readonly #tools = new Map<string, { startedAt: number, turnId?: string, authorized: boolean }>()
  #turnSequence = 0
  #turn: { id: string, startedAt: number } | null = null
  #retryStartedAt: number | undefined
  #compactionStartedAt: number | undefined

  constructor(input: { runId: string, conversationId?: string, branchId?: string, report: ApplicationDiagnosticReporter }) {
    this.#runId = input.runId
    this.#events = new ApplicationEvents({ component: 'runtime.pi', runId: input.runId, conversationId: input.conversationId, branchId: input.branchId })
    this.#events.subscribe(input.report)
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'turn_start': {
        this.#endTurn('interrupted')
        this.#turn = { id: `${this.#runId}:${++this.#turnSequence}`, startedAt: performance.now() }
        this.#events.publish({ event: 'turn.started', level: 'info', turnId: this.#turn.id })
        break
      }
      case 'turn_end': {
        const reason = event.message.role === 'assistant' ? event.message.stopReason : undefined
        if (event.message.role === 'assistant' && event.message.diagnostics?.some(diagnostic => diagnostic.type === INFERRED_STREAM_COMPLETION))
          this.#events.publish({ event: INFERRED_STREAM_COMPLETION, level: 'warn', turnId: this.#turn?.id })
        this.#endTurn(reason === 'error' ? 'failed' : reason === 'aborted' ? 'cancelled' : 'completed')
        break
      }
      case 'tool_execution_start': {
        this.#tools.set(event.toolCallId, { startedAt: performance.now(), turnId: this.#turn?.id, authorized: false })
        this.#events.publish({ event: 'tool.requested', level: 'info', toolCallId: diagnosticToolCallId(event.toolCallId), turnId: this.#turn?.id })
        break
      }
      case 'tool_execution_end': {
        const tool = this.#tools.get(event.toolCallId)
        if (tool?.authorized)
          this.#events.publish({ event: event.isError ? 'tool.failed' : 'tool.completed', level: event.isError ? 'warn' : 'info', toolCallId: diagnosticToolCallId(event.toolCallId), turnId: tool.turnId, durationMs: Math.round(performance.now() - tool.startedAt) })
        this.#tools.delete(event.toolCallId)
        break
      }
      case 'auto_retry_start':
        this.#retryStartedAt = performance.now()
        this.#events.publish({ event: 'model.retry.started', level: 'warn', attempt: event.attempt, turnId: this.#turn?.id })
        break
      case 'auto_retry_end':
        this.#events.publish({ event: event.success ? 'model.retry.completed' : 'model.retry.failed', level: event.success ? 'info' : 'error', attempt: event.attempt, durationMs: elapsed(this.#retryStartedAt) })
        this.#retryStartedAt = undefined
        break
      case 'compaction_start':
        this.#compactionStartedAt = performance.now()
        this.#events.publish({ event: 'model.compaction.started', level: 'info' })
        break
      case 'compaction_end':
        this.#events.publish({ event: `model.compaction.${event.aborted ? 'cancelled' : event.result ? 'completed' : 'failed'}`, level: event.aborted || event.result ? 'info' : 'error', durationMs: elapsed(this.#compactionStartedAt) })
        this.#compactionStartedAt = undefined
        break
      case 'agent_settled':
        this.#events.publish({ event: 'execution.settled', level: 'info' })
        break
    }
  }

  authorized(toolCallId: string): void {
    const tool = this.#tools.get(toolCallId)
    if (tool) {
      tool.authorized = true
      tool.startedAt = performance.now()
    }
    this.#events.publish({ event: 'tool.authorized', level: 'info', toolCallId: diagnosticToolCallId(toolCallId), turnId: tool?.turnId ?? this.#turn?.id })
  }

  denied(toolCallId: string, errorCode: string): void {
    this.#events.publish({ event: isToolFailureCode(errorCode) ? 'tool.failed' : 'tool.denied', level: 'warn', toolCallId: diagnosticToolCallId(toolCallId), turnId: this.#tools.get(toolCallId)?.turnId ?? this.#turn?.id, errorCode })
    this.#tools.delete(toolCallId)
  }

  settle(): void {
    this.#endTurn('interrupted')
    for (const [toolCallId, tool] of this.#tools)
      this.#events.publish({ event: 'tool.interrupted', level: 'warn', toolCallId: diagnosticToolCallId(toolCallId), turnId: tool.turnId, durationMs: elapsed(tool.startedAt) })
    this.#tools.clear()
    if (this.#retryStartedAt !== undefined)
      this.#events.publish({ event: 'model.retry.cancelled', level: 'info', durationMs: elapsed(this.#retryStartedAt) })
    if (this.#compactionStartedAt !== undefined)
      this.#events.publish({ event: 'model.compaction.cancelled', level: 'info', durationMs: elapsed(this.#compactionStartedAt) })
    this.#retryStartedAt = this.#compactionStartedAt = undefined
  }

  #endTurn(status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): void {
    if (!this.#turn)
      return
    this.#events.publish({ event: `turn.${status}`, level: status === 'failed' ? 'error' : status === 'interrupted' ? 'warn' : 'info', turnId: this.#turn.id, durationMs: elapsed(this.#turn.startedAt) })
    this.#turn = null
  }
}

function elapsed(startedAt: number | undefined): number | undefined {
  return startedAt === undefined ? undefined : Math.round(performance.now() - startedAt)
}

function diagnosticToolCallId(id: string): string {
  return diagnosticIdentitySchema.safeParse(id).success ? id : `pi:${createHash('sha256').update(id).digest('hex')}`
}
