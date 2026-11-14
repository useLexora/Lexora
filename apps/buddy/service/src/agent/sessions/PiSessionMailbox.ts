import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ExecutionMailboxMessage, ExecutionMailboxReceipt } from '../../../../shared/executions/executionApi'
import type { BuddyExtensionRunContext, BuddyExtensionRunContextStore } from '../extensions/BuddyExtensionRunContext'
import { EXECUTION_MAILBOX_ENTRY_TYPE, executionMailboxMessageSchema, executionMailboxReceiptSchema } from '../../../../shared/executions/executionApi'
import { BuddyAgentRunError } from '../../runs/runError'
import { readExecutionMailboxEntries, renderMailboxMessage } from '../execution/executionMailboxEntries'
import { BuddySessionStorageError } from './BuddySessionErrors'
import { syncBuddySessionJournal } from './tree/syncBuddySessionJournal'
import { withPiSessionStorageBoundary } from './withPiSessionStorageBoundary'

export class PiSessionMailbox {
  readonly #session: AgentSession
  readonly #runs: BuddyExtensionRunContextStore
  readonly #generation: () => number | undefined

  constructor(session: AgentSession, runs: BuddyExtensionRunContextStore, generation: () => number | undefined) {
    this.#session = session
    this.#runs = runs
    this.#generation = generation
  }

  appendPending(messages: readonly ExecutionMailboxMessage[], run: BuddyExtensionRunContext) {
    return withPiSessionStorageBoundary(this.#session, async () => {
      for (const value of messages) {
        const message = this.#message(value, run)
        this.#session.sessionManager.appendCustomMessageEntry(EXECUTION_MAILBOX_ENTRY_TYPE, renderMailboxMessage(message), false, message)
      }
      syncBuddySessionJournal(this.#session.sessionManager)
      this.#assertCurrent(run)
      return this.#session.sessionManager.buildSessionProjection().messages
    })
  }

  readReceipts(messages: readonly ExecutionMailboxMessage[], run: BuddyExtensionRunContext) {
    return withPiSessionStorageBoundary(this.#session, async () => {
      const receipts: ExecutionMailboxReceipt[] = []
      for (const value of messages) {
        const message = this.#message(value, run)
        const entry = this.#find(message)
        if (entry)
          receipts.push({ sourceRunId: message.sourceRunId, messageId: message.messageId, payloadHash: message.payloadHash, contextEntryId: entry.contextEntryId })
      }
      if (receipts.length)
        syncBuddySessionJournal(this.#session.sessionManager)
      this.#assertCurrent(run)
      return receipts
    })
  }

  append(messages: readonly ExecutionMailboxMessage[], run: BuddyExtensionRunContext) {
    return withPiSessionStorageBoundary(this.#session, async () => {
      const receipts: ExecutionMailboxReceipt[] = []
      for (const value of messages) {
        const message = this.#message(value, run)
        this.#assertCurrent(run)
        let entry = this.#find(message)
        if (!entry) {
          await this.#session.sendCustomMessage({ customType: EXECUTION_MAILBOX_ENTRY_TYPE, content: renderMailboxMessage(message), details: message, display: false }, { triggerTurn: false })
          this.#assertCurrent(run)
          entry = this.#find(message)
        }
        if (!entry)
          throw new BuddySessionStorageError()
        receipts.push({ sourceRunId: message.sourceRunId, messageId: message.messageId, payloadHash: message.payloadHash, contextEntryId: entry.contextEntryId })
      }
      if (receipts.length)
        syncBuddySessionJournal(this.#session.sessionManager)
      this.#assertCurrent(run)
      return receipts
    })
  }

  resolveReceipts(receipts: readonly ExecutionMailboxReceipt[]) {
    if (!receipts.length)
      throw new BuddyAgentRunError('VALIDATION_FAILED')
    return receipts.map((value) => {
      const receipt = executionMailboxReceiptSchema.parse(value)
      const entry = this.#entries().find(entry => entry.contextEntryId === receipt.contextEntryId && entry.message.sourceRunId === receipt.sourceRunId && entry.message.messageId === receipt.messageId)
      if (!entry || entry.message.payloadHash !== receipt.payloadHash)
        throw new BuddySessionStorageError()
      return { sourceRunId: receipt.sourceRunId, messageId: receipt.messageId, payloadHash: receipt.payloadHash }
    })
  }

  #message(value: ExecutionMailboxMessage, run: BuddyExtensionRunContext): ExecutionMailboxMessage {
    const message = executionMailboxMessageSchema.parse(value)
    if (message.targetRunId !== run.runId || message.targetGeneration !== this.#generation())
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    return message
  }

  #assertCurrent(run: BuddyExtensionRunContext) {
    run.signal.throwIfAborted()
    if (this.#runs.current !== run)
      throw new BuddyAgentRunError('RUN_STATE_MISMATCH')
  }

  #entries() {
    const run = this.#runs.current
    const generation = this.#generation()
    if (!run || generation === undefined)
      throw new BuddyAgentRunError('RUN_STATE_MISMATCH')
    return readExecutionMailboxEntries(this.#session.sessionManager.getBranch(), { runId: run.runId, generation })
  }

  #find(message: ExecutionMailboxMessage) {
    const entry = this.#entries().find(entry => entry.message.sourceRunId === message.sourceRunId && entry.message.messageId === message.messageId)
    if (entry && JSON.stringify(entry.message) !== JSON.stringify(message))
      throw new BuddySessionStorageError()
    return entry ?? null
  }
}
