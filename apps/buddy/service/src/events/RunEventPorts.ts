import type { Event } from '../../../shared/events/Emitter'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type {
  AppendBuddyRunEventInput,
  BuddyRunEvent,
  ListBuddyRunEventsOptions,
} from './BuddyRunEvent'
import type { RunEventRecoveryFailure, RunEventRecoverySummary } from './RunEventRecovery'

export interface RunEventWriter {
  append: (input: AppendBuddyRunEventInput) => Promise<BuddyRunEvent>
  appendBatch: (inputs: readonly AppendBuddyRunEventInput[]) => Promise<BuddyRunEvent[]>
}

export interface RunEventReader {
  findLatest: (runId: string, eventTypes: readonly string[]) => Promise<BuddyRunEvent | null>
  list: (
    runId: string,
    options?: ListBuddyRunEventsOptions,
  ) => Promise<BuddyRunEvent[]>
  listForConversation: (
    conversationId: string,
    options?: Pick<ListBuddyRunEventsOptions, 'limit'>,
  ) => BuddyRunEvent[]
  listForRuns: (runIds: readonly string[], options?: { latestActivityOnly?: boolean }) => BuddyRunEvent[]
  listToolCounts: (runIds: readonly string[]) => ReadonlyMap<string, number>
  read: (runId: string) => Promise<BuddyRunEvent[]>
}

export interface RunEventMaintenance {
  close: () => Promise<void>
  compactTerminalRun: (runId: string) => Promise<number>
  compactTerminalRuns: () => Promise<number>
  recoverAll: (options?: { force?: boolean }) => Promise<Readonly<RunEventRecoverySummary>>
  replay: (runId: string) => Promise<number>
  replayAll: () => Promise<number>
}

export interface RunEventObservation {
  readonly onDidCommit: Event<EventSnapshot<BuddyRunEvent>>
  readonly state: 'open' | 'failed' | 'closed'
}

export interface RunEventAvailability {
  assertConversationWritable: (conversationId: string) => void
  assertRunWritable: (runId: string) => void
  assertRunExecutable: (runId: string) => void
  getRecoveryFailures: () => readonly Readonly<RunEventRecoveryFailure>[]
}

export interface RunEventLogPort
  extends RunEventAvailability, RunEventMaintenance, RunEventReader, RunEventWriter, RunEventObservation {
  readonly onDidQuarantine: Event<Readonly<RunEventRecoveryFailure>>
}
