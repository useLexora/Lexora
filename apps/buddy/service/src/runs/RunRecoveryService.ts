import type { CommittedPiCompactionEvidence } from '../agent/sessions/recovery/inspectCommittedPiCompaction'
import type { AppendBuddyRunEventInput, BuddyRunEvent } from '../events/BuddyRunEvent'
import type { RunEventAvailability, RunEventReader, RunEventWriter } from '../events/RunEventPorts'
import type { ConversationHistoryRepository } from '../storage/conversationHistoryRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { UsageService } from '../usage/UsageService'
import type { RunLifecycleService } from './RunLifecycleService'
import { createBuddyInterruptedMessageContent } from '../../../shared/conversation/buddyMessageContent'
import { createInterruptedMessageEvents } from '../events/createInterruptedMessageEvents'
import { RunEventCorruptionError, RunEventLogUnavailableError } from '../events/RunEventFailure'
import { readStableRunErrorCode } from './runError'

export interface RunRecoveryServiceOptions {
  cancelPendingApprovals?: (canRecoverRun: (runId: string) => boolean) => Promise<number>
  captureInterruptedChanges?: (runId: string) => Promise<void>
  conversations: Pick<ConversationHistoryRepository, 'findMessageById'>
  eventLog: Pick<RunEventReader, 'read'> & Pick<RunEventWriter, 'append'>
    & Partial<Pick<RunEventAvailability, 'assertRunWritable' | 'getRecoveryFailures'>>
  inspectCommittedCompaction?: (
    run: RunRecord,
  ) => Promise<CommittedPiCompactionEvidence | null>
  lifecycle: Pick<RunLifecycleService, 'finalize'>
  repository: Pick<RunRepository, 'listIncomplete' | 'reconcileQuarantined'>
  usage: Pick<UsageService, 'record'>
}

export class RunRecoveryService {
  readonly #options: RunRecoveryServiceOptions
  #lastTimestamp = 0

  constructor(options: RunRecoveryServiceOptions) {
    this.#options = options
  }

  async recoverInterruptedRuns(): Promise<number> {
    const interrupted = this.#options.repository.listIncomplete()
    const histories = new Map<string, BuddyRunEvent[]>()
    const quarantined = new Set(this.#options.eventLog.getRecoveryFailures?.().map(failure => failure.runId))
    for (const run of interrupted) {
      try {
        this.#options.eventLog.assertRunWritable?.(run.id)
        histories.set(run.id, await this.#options.eventLog.read(run.id))
      }
      catch (error) {
        if (!(error instanceof RunEventCorruptionError))
          throw error
        quarantined.add(run.id)
      }
    }
    const canRecoverRun = (runId: string): boolean => {
      if (quarantined.has(runId))
        return false
      try {
        this.#options.eventLog.assertRunWritable?.(runId)
        return true
      }
      catch (error) {
        if (!(error instanceof RunEventCorruptionError))
          throw error
        quarantined.add(runId)
        return false
      }
    }
    await this.#options.cancelPendingApprovals?.(canRecoverRun)
    let recovered = 0
    for (const run of interrupted) {
      if (!canRecoverRun(run.id))
        continue
      try {
        const events = histories.get(run.id)!
        await this.#options.captureInterruptedChanges?.(run.id)
        if (await this.#recoverInterruptedCompaction(run, events)) {
          recovered++
          continue
        }
        const recoveredMessages: AppendBuddyRunEventInput[] = createInterruptedMessageEvents(events)
          .filter(snapshot => !this.#options.conversations.findMessageById(snapshot.messageId))
          .map(snapshot => ({
            createdAt: this.#timestamp(),
            payload: {
              content: createBuddyInterruptedMessageContent(
                snapshot.text,
                snapshot.truncated,
              ),
              messageId: snapshot.messageId,
              reason: 'runtime_restarted',
              role: 'assistant',
            },
            runId: run.id,
            type: 'message.interrupted' as const,
          }))
        await this.#options.lifecycle.finalize({
          completedAt: this.#timestamp(),
          errorCode: 'RUNTIME_RESTARTED',
          precedingEvents: recoveredMessages,
          runId: run.id,
          status: 'failed',
        })
        recovered++
      }
      catch (error) {
        if (!(error instanceof RunEventCorruptionError))
          throw error
        quarantined.add(run.id)
      }
    }
    for (const runId of quarantined) {
      if (this.recoverQuarantinedRun(runId))
        recovered++
    }
    return recovered
  }

  recoverQuarantinedRun(runId: string): boolean {
    try {
      this.#options.eventLog.assertRunWritable?.(runId)
      return false
    }
    catch (error) {
      if (!(error instanceof RunEventCorruptionError))
        throw error
      return this.#options.repository.reconcileQuarantined(runId, this.#timestamp())
    }
  }

  async #recoverInterruptedCompaction(run: RunRecord, events: readonly BuddyRunEvent[]): Promise<boolean> {
    if (run.purpose !== 'conversation.compaction')
      return false

    const completionRecorded = events.some(
      event => event.type === 'context.compaction.completed',
    )
    let evidence: CommittedPiCompactionEvidence | null = null
    if (run.piSessionFile && this.#options.inspectCommittedCompaction) {
      try {
        evidence = await this.#options.inspectCommittedCompaction(run)
      }
      catch (error) {
        const errorCode = readStableRunErrorCode(error)
        if (!completionRecorded && errorCode === 'SESSION_STORAGE_UNAVAILABLE') {
          await this.#finalize(run.id, 'failed', errorCode)
          return true
        }
      }
    }
    if (!completionRecorded && !evidence)
      return false

    if (!completionRecorded && evidence) {
      await this.#options.eventLog.append({
        payload: {
          estimatedTokensAfter: evidence.estimatedTokensAfter,
          reason: 'manual',
          tokensBefore: evidence.tokensBefore,
          willRetry: false,
        },
        runId: run.id,
        type: 'context.compaction.completed',
      })
    }
    if (evidence?.usage) {
      try {
        await this.#options.usage.record({
          createdAt: this.#timestamp(),
          model: run.model,
          provider: run.provider,
          purpose: 'compaction',
          runId: run.id,
          sourceEntryId: `compaction:${evidence.firstKeptEntryId}`,
          usage: evidence.usage,
        })
      }
      catch (error) {
        if (error instanceof RunEventLogUnavailableError)
          throw error
      }
    }
    await this.#finalize(run.id, 'completed', null)
    return true
  }

  #finalize(
    runId: string,
    status: 'completed' | 'failed',
    errorCode: string | null,
  ) {
    return this.#options.lifecycle.finalize({
      completedAt: this.#timestamp(),
      errorCode,
      runId,
      status,
    })
  }

  #timestamp(): string {
    this.#lastTimestamp = Math.max(Date.now(), this.#lastTimestamp + 1)
    return new Date(this.#lastTimestamp).toISOString()
  }
}
