import type { AgentSessionEvent, CompactionResult } from '@earendil-works/pi-coding-agent'
import type { ApplicationDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'
import type { RunEventWriter } from '../../events/RunEventPorts'
import type { BuddyUsagePurpose } from '../../usage/recordPiUsage'
import type { UsageService } from '../../usage/UsageService'
import type { BuddySessionEventSource } from '../sessions/ReusableBuddySession'
import type { BuddyProjectedEvent } from './projectPiEvent'
import { safeDiagnosticReporter } from '../../../../shared/diagnostics/applicationDiagnostic'
import { RunEventLogFatalError } from '../../events/RunEventFailure'
import { isPiShellToolName } from '../extensions/piBuiltinTools'
import { BufferedRunEventWriter } from './BufferedRunEventWriter'
import { PiApplicationObserver } from './PiApplicationObserver'
import {
  createPiEventProjectionState,
  projectPiEvent,
  projectToolExecutionAuthorized,
  projectToolExecutionDenied,
} from './projectPiEvent'

type PiEventLog = RunEventWriter
type PiUsageService = Pick<UsageService, 'record' | 'recordMessage'>
type PiToolExecutionUpdateEvent = Extract<AgentSessionEvent, { type: 'tool_execution_update' }>

const TERMINAL_TOOL_UPDATE_WINDOW_MS = 25

export interface CreatePiEventChannelInput {
  conversationId?: string
  branchId?: string
  canonicalRoot: string
  model: string
  provider: string
  runId: string
  session: BuddySessionEventSource
  timestamp: () => string
}

export interface PiToolExecutionAuthorizedEvent {
  arguments: unknown
  toolCallId: string
  toolName: string
}

export interface PiToolExecutionDeniedEvent {
  denialCode: string
  toolCallId: string
  toolName: string
}

export interface PiEventBridgeSettlement {
  eventError: unknown | null
  writerError: unknown | null
}

export interface PiTurnEventOutcome {
  failureCode: string | undefined
  failureMessage: string | undefined
  finalAssistantAnswerProjected: boolean
}

interface PiEventChannel {
  flush: () => Promise<void>
  settle: () => Promise<PiEventBridgeSettlement>
  subscribe: () => () => void
}

export interface PiTurnEventChannel extends PiEventChannel {
  readonly outcome: PiTurnEventOutcome
  projectToolExecutionAuthorized: (
    event: PiToolExecutionAuthorizedEvent,
  ) => Promise<void>
  projectToolExecutionDenied: (
    event: PiToolExecutionDeniedEvent,
  ) => Promise<void>
}

export interface PiCompactionEventChannel extends PiEventChannel {
  recordCompactionResult: (result: CompactionResult) => Promise<void>
}

export interface PiEventBridgeOptions {
  record?: ApplicationDiagnosticReporter
  eventLog: PiEventLog
  usage: PiUsageService
}

export class PiEventBridge {
  readonly #record: ApplicationDiagnosticReporter
  readonly #eventLog: PiEventLog
  readonly #usage: PiUsageService

  constructor(options: PiEventBridgeOptions) {
    this.#record = safeDiagnosticReporter(options.record)
    this.#eventLog = options.eventLog
    this.#usage = options.usage
  }

  createTurn(input: CreatePiEventChannelInput): PiTurnEventChannel {
    return new ActivePiEventChannel({
      ...input,
      eventLog: this.#eventLog,
      recordEventUsage: true,
      record: this.#record,
      usage: this.#usage,
    })
  }

  createCompaction(input: CreatePiEventChannelInput): PiCompactionEventChannel {
    return new ActivePiEventChannel({
      ...input,
      eventLog: this.#eventLog,
      recordEventUsage: false,
      record: this.#record,
      usage: this.#usage,
    })
  }
}

interface ActivePiEventChannelOptions extends CreatePiEventChannelInput {
  record: ApplicationDiagnosticReporter
  eventLog: PiEventLog
  recordEventUsage: boolean
  usage: PiUsageService
}

class ActivePiEventChannel implements PiCompactionEventChannel, PiTurnEventChannel {
  readonly #observer: PiApplicationObserver
  readonly #eventLog: PiEventLog
  readonly #eventWriter: BufferedRunEventWriter
  readonly #model: string
  readonly #projectionState: ReturnType<typeof createPiEventProjectionState>
  readonly #provider: string
  readonly #recordEventUsage: boolean
  readonly #runId: string
  readonly #session: BuddySessionEventSource
  readonly #timestamp: () => string
  readonly #usage: PiUsageService
  #eventTail = Promise.resolve()
  #failureCode: string | undefined
  #failureMessage: string | undefined
  #finalAssistantAnswerProjected = false
  #pendingTerminalToolUpdates = new Map<string, PiToolExecutionUpdateEvent>()
  #terminalToolUpdateTimer: NodeJS.Timeout | undefined

  constructor(options: ActivePiEventChannelOptions) {
    this.#observer = new PiApplicationObserver({ ...options, report: options.record })
    this.#eventLog = options.eventLog
    this.#eventWriter = new BufferedRunEventWriter(
      options.eventLog,
      options.runId,
      options.timestamp,
    )
    this.#model = options.model
    this.#projectionState = createPiEventProjectionState({
      canonicalRoot: options.canonicalRoot,
    })
    this.#provider = options.provider
    this.#recordEventUsage = options.recordEventUsage
    this.#runId = options.runId
    this.#session = options.session
    this.#timestamp = options.timestamp
    this.#usage = options.usage
  }

  get outcome(): PiTurnEventOutcome {
    return {
      failureCode: this.#failureCode,
      failureMessage: this.#failureMessage,
      finalAssistantAnswerProjected: this.#finalAssistantAnswerProjected,
    }
  }

  async flush(): Promise<void> {
    this.#flushPendingTerminalToolUpdates()
    await this.#eventTail
    await this.#eventWriter.drain()
  }

  async projectToolExecutionAuthorized(
    event: PiToolExecutionAuthorizedEvent,
  ): Promise<void> {
    await this.flush()
    const projected = projectToolExecutionAuthorized(event, this.#projectionState)
    this.#appendProjectedEvents(projected.events)
    await this.#eventWriter.drain()
    this.#observer.authorized(event.toolCallId)
  }

  async projectToolExecutionDenied(
    event: PiToolExecutionDeniedEvent,
  ): Promise<void> {
    await this.flush()
    this.#eventWriter.appendBatch(projectToolExecutionDenied(event).events)
    await this.#eventWriter.drain()
    this.#observer.denied(event.toolCallId, event.denialCode)
  }

  async recordCompactionResult(result: CompactionResult): Promise<void> {
    await this.#recordUsageWithDegradation('compaction', () => (
      this.#recordCompactionResultUsage(result)
    ))
  }

  async settle(): Promise<PiEventBridgeSettlement> {
    this.#flushPendingTerminalToolUpdates()
    const eventError = await settledError(this.#eventTail)
    const writerError = await settledError(this.#eventWriter.drain())
    this.#observer.settle()
    return { eventError, writerError }
  }

  subscribe(): () => void {
    return this.#session.subscribe((event) => {
      this.#observer.handle(event)
      if (isTerminalToolExecutionUpdate(event)) {
        this.#queueTerminalToolUpdate(event)
        return
      }
      this.#flushPendingTerminalToolUpdates()
      this.#enqueueEvent(event)
    })
  }

  #enqueueEvent(event: AgentSessionEvent): void {
    this.#eventTail = this.#eventTail.then(() => this.#handleEvent(event))
  }

  #flushPendingTerminalToolUpdates(): void {
    if (this.#terminalToolUpdateTimer) {
      clearTimeout(this.#terminalToolUpdateTimer)
      this.#terminalToolUpdateTimer = undefined
    }
    if (this.#pendingTerminalToolUpdates.size === 0)
      return
    const updates = [...this.#pendingTerminalToolUpdates.values()]
    this.#pendingTerminalToolUpdates.clear()
    for (const event of updates)
      this.#enqueueEvent(event)
  }

  #queueTerminalToolUpdate(event: PiToolExecutionUpdateEvent): void {
    this.#pendingTerminalToolUpdates.delete(event.toolCallId)
    this.#pendingTerminalToolUpdates.set(event.toolCallId, event)
    if (this.#terminalToolUpdateTimer)
      return
    this.#terminalToolUpdateTimer = setTimeout(
      () => this.#flushPendingTerminalToolUpdates(),
      TERMINAL_TOOL_UPDATE_WINDOW_MS,
    )
    this.#terminalToolUpdateTimer.unref()
  }

  async #handleEvent(event: AgentSessionEvent): Promise<void> {
    const projected = projectPiEvent(event, this.#projectionState)
    if (projected.failureCode) {
      this.#failureCode = projected.failureCode
      this.#failureMessage = projected.failureMessage
    }
    if (event.type === 'auto_retry_end' && event.success) {
      this.#failureCode = undefined
      this.#failureMessage = undefined
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      this.#finalAssistantAnswerProjected = event.message.stopReason === 'stop'
        && projected.events.some(candidate => candidate.type === 'message.completed')
    }
    this.#appendProjectedEvents(projected.events)
    if (this.#recordEventUsage)
      await this.#recordUsageFromEvent(event, projected.sourceMessageId)
  }

  #appendProjectedEvents(events: readonly BuddyProjectedEvent[]): void {
    this.#eventWriter.appendBatch(events.map((event) => {
      if (event.type !== 'tool.preparing' && event.type !== 'tool.started' && event.type !== 'tool.completed')
        return event
      const payload = event.payload
      if (!payload || typeof payload !== 'object' || !('toolName' in payload) || typeof payload.toolName !== 'string')
        return event
      const toolLabel = this.#session.getToolLabel?.(payload.toolName)?.trim().slice(0, 256)
      return toolLabel ? { ...event, payload: { ...payload, toolLabel } } : event
    }))
  }

  async #recordUsageFromEvent(
    event: AgentSessionEvent,
    sourceMessageId: string | undefined,
  ): Promise<void> {
    if (event.type === 'entry_appended' && event.entry.type === 'usage' && event.entry.kind === 'cache_warm') {
      const { entry } = event
      await this.#eventWriter.drain()
      await this.#recordUsageWithDegradation('cache_warm', () => this.#usage.record({
        createdAt: entry.timestamp,
        model: entry.model,
        provider: entry.provider,
        purpose: 'cache_warm',
        runId: this.#runId,
        sourceEntryId: entry.id,
        usage: entry.usage,
      }))
    }
    if (event.type === 'message_end' && sourceMessageId) {
      const message = event.message
      const purpose = message.role === 'assistant'
        ? 'turn'
        : message.role === 'toolResult' && message.usage
          ? 'tool'
          : null
      if (purpose) {
        await this.#eventWriter.drain()
        const usageRecord = await this.#recordUsageWithDegradation(purpose, () => (
          this.#usage.recordMessage({
            createdAt: this.#timestamp(),
            fallbackModel: this.#model,
            fallbackProvider: this.#provider,
            message,
            runId: this.#runId,
            sourceMessageId,
          })
        ))
        if (purpose === 'turn' && usageRecord) {
          const contextTokens = usageRecord.inputTokens
            + usageRecord.cacheReadTokens
            + usageRecord.cacheWriteTokens
            || Math.max(0, usageRecord.totalTokens - usageRecord.outputTokens)
          const breakdown = await this.#session.getContextUsageBreakdown?.(contextTokens)
          if (breakdown) {
            await this.#eventLog.append({
              payload: {
                ...breakdown,
                model: usageRecord.model,
                provider: usageRecord.provider,
                totalTokens: contextTokens,
              },
              runId: this.#runId,
              type: 'context.usage.updated',
            })
          }
        }
      }
    }
    if (event.type === 'compaction_end') {
      const result = event.result
      if (result?.usage) {
        await this.#eventWriter.drain()
        await this.#recordUsageWithDegradation('compaction', () => (
          this.#recordCompactionResultUsage(result)
        ))
      }
    }
  }

  async #recordUsageWithDegradation<TResult>(
    purpose: BuddyUsagePurpose,
    record: () => Promise<TResult>,
  ): Promise<TResult | null> {
    try {
      return await record()
    }
    catch (error) {
      if (error instanceof RunEventLogFatalError)
        throw error
      await this.#eventLog.append({
        payload: {
          errorCode: 'USAGE_RECORDING_FAILED',
          purpose,
        },
        runId: this.#runId,
        type: 'usage.recording.degraded',
      })
      return null
    }
  }

  #recordCompactionResultUsage(
    result: CompactionResult,
  ): ReturnType<UsageService['record']> {
    if (!result.usage)
      return Promise.resolve(null)
    return this.#usage.record({
      createdAt: this.#timestamp(),
      model: this.#model,
      provider: this.#provider,
      purpose: 'compaction',
      runId: this.#runId,
      sourceEntryId: `compaction:${result.firstKeptEntryId}`,
      usage: result.usage,
    })
  }
}

function isTerminalToolExecutionUpdate(
  event: AgentSessionEvent,
): event is PiToolExecutionUpdateEvent {
  return event.type === 'tool_execution_update' && (isPiShellToolName(event.toolName) || event.toolName === 'lexora_host_shell')
}

async function settledError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return null
  }
  catch (error) {
    return error
  }
}
