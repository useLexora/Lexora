import type { DatabaseSync } from 'node:sqlite'
import type { StorageCommand } from '../storage/CommandCommitter'
import type { PrepareCommandRequestInput } from '../storage/commandRequestRepository'
import type { EditTurnRequestInput, PrepareTurnRequestInput, RegenerateTurnRequestInput, TurnCommitFact, TurnRequestRecord } from '../storage/turnRequestRepository'
import { randomUUID } from 'node:crypto'
import { SqliteRunEventWriter } from '../events/SqliteRunEventWriter'
import { CommandCommitter } from '../storage/CommandCommitter'
import { createCommandRequestRepository } from '../storage/commandRequestRepository'
import { withTransaction } from '../storage/transaction'
import { TurnRequestService } from './TurnRequestService'

type PreparedCommand = Omit<StorageCommand, 'method' | 'sourceInstanceId'>
type PreparedInput<T> = Omit<T, 'requestId' | 'requestFingerprint' | 'queuedMessageId'>

export class PreparedRunCommandService {
  readonly #ownsTurns: boolean
  readonly #ownsEvents: boolean
  readonly #database: DatabaseSync
  readonly #sourceInstanceId: string
  readonly #commands: CommandCommitter
  readonly #turns: TurnRequestService
  readonly #compaction: ReturnType<typeof createCommandRequestRepository>
  readonly events: SqliteRunEventWriter
  readonly onDidCommit: TurnRequestService['onDidCommit']

  constructor(options: { database: DatabaseSync, sourceInstanceId: string, turns?: TurnRequestService, events?: SqliteRunEventWriter, onObserverError?: (error: unknown) => void }) {
    this.#database = options.database
    this.#sourceInstanceId = options.sourceInstanceId
    this.#commands = new CommandCommitter(options.database)
    this.#ownsTurns = !options.turns
    this.#ownsEvents = !options.events
    this.#turns = options.turns ?? new TurnRequestService(options.database, options.onObserverError)
    this.#compaction = createCommandRequestRepository(options.database)
    this.events = options.events ?? new SqliteRunEventWriter(options.database, options.onObserverError)
    this.onDidCommit = this.#turns.onDidCommit
  }

  start(command: PreparedCommand, input: PreparedInput<PrepareTurnRequestInput>) {
    return this.#accept(command, 'chat.startTurn', () => this.commitStart(command.fingerprint, input))
  }

  edit(command: PreparedCommand, input: PreparedInput<EditTurnRequestInput>) {
    return this.#accept(command, 'chat.editUserMessage', () => this.commitEdit(command.fingerprint, input))
  }

  regenerate(command: PreparedCommand, input: PreparedInput<RegenerateTurnRequestInput>) {
    return this.#accept(command, 'chat.regenerateAssistant', () => this.commitRegenerate(command.fingerprint, input))
  }

  compact(command: PreparedCommand, input: PreparedInput<PrepareCommandRequestInput>) {
    return this.#accept(command, 'chat.executeCommand', () => this.commitCompact(command.fingerprint, input))
  }

  commitStart(fingerprint: string, input: PreparedInput<PrepareTurnRequestInput>) {
    return this.#commit(input.createdAt, () => this.#turns.prepare({ ...input, requestId: randomUUID(), requestFingerprint: fingerprint }))
  }

  commitEdit(fingerprint: string, input: PreparedInput<EditTurnRequestInput>) {
    return this.#commit(input.createdAt, () => this.#turns.edit({ ...input, requestId: randomUUID(), requestFingerprint: fingerprint }))
  }

  commitRegenerate(fingerprint: string, input: PreparedInput<RegenerateTurnRequestInput>) {
    return this.#commit(input.createdAt, () => this.#turns.regenerate({ ...input, requestId: randomUUID(), requestFingerprint: fingerprint }))
  }

  commitCompact(fingerprint: string, input: PreparedInput<PrepareCommandRequestInput>) {
    return this.#commit(input.createdAt, () => {
      const request = this.#compaction.prepare({ ...input, requestId: randomUUID(), requestFingerprint: fingerprint })
      const committedFacts: TurnCommitFact[] = [{ kind: 'run.queued' }, ...(request.draftReceipt ? [{ kind: 'draft.consumed' as const, receipt: request.draftReceipt }] : [])]
      return { ...request, committedFacts }
    })
  }

  find(command: Pick<PreparedCommand, 'dataGeneration' | 'actorId' | 'commandId'>) {
    return this.#commands.find(command)
  }

  dispose(): void {
    if (this.#ownsTurns)
      this.#turns.dispose()
    if (this.#ownsEvents)
      this.events.dispose()
  }

  #accept(command: PreparedCommand, method: string, operation: () => ReturnType<PreparedRunCommandService['commitStart']>) {
    return this.#commands.accept({ ...command, method, sourceInstanceId: this.#sourceInstanceId }, () => operation().decision)
  }

  #commit(createdAt: string, operation: () => TurnRequestRecord) {
    return withTransaction(this.#database, () => {
      const request = operation()
      if (!request.created || !request.committedFacts?.length)
        throw new Error('A new command must create its own run and acceptance facts')
      if (!this.#database.prepare('SELECT 1 FROM run_events WHERE run_id = ? AND event_type = \'run.queued\'').get(request.runId)) {
        this.#database.prepare('UPDATE runs SET next_event_sequence = 1 WHERE id = ? AND next_event_sequence IS NULL').run(request.runId)
        this.events.append({
          runId: request.runId,
          type: 'run.queued',
          payload: { requestId: request.requestId, facts: request.committedFacts },
          createdAt,
        })
      }
      return {
        request,
        decision: {
          target: { runId: request.runId, conversationId: request.conversationId, branchId: request.branchId },
          result: { draftReceipt: request.draftReceipt },
        },
      }
    })
  }
}
