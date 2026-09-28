import type { Event } from '../../../shared/events/Emitter'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type {
  AppendBuddyRunEventInput,
  BuddyRunEvent,
  ListBuddyRunEventsOptions,
} from './BuddyRunEvent'

export interface RunEventWriter {
  append: (input: AppendBuddyRunEventInput) => Promise<BuddyRunEvent>
  appendBatch: (inputs: readonly AppendBuddyRunEventInput[]) => Promise<BuddyRunEvent[]>
}

export interface RunEventReader {
  list: (
    runId: string,
    options?: ListBuddyRunEventsOptions,
  ) => Promise<BuddyRunEvent[]>
  listForConversation: (
    conversationId: string,
    options?: Pick<ListBuddyRunEventsOptions, 'limit'>,
  ) => BuddyRunEvent[]
  listForRuns: (runIds: readonly string[]) => BuddyRunEvent[]
  read: (runId: string) => Promise<BuddyRunEvent[]>
}

export interface RunEventMaintenance {
  close: () => Promise<void>
  compactTerminalRun: (runId: string) => Promise<number>
  compactTerminalRuns: () => Promise<number>
  replay: (runId: string) => Promise<number>
  replayAll: () => Promise<number>
}

export interface RunEventObservation {
  readonly onDidCommit: Event<EventSnapshot<BuddyRunEvent>>
  readonly state: 'open' | 'failed' | 'closed'
}

export interface RunEventLogPort
  extends RunEventMaintenance, RunEventReader, RunEventWriter, RunEventObservation {}
