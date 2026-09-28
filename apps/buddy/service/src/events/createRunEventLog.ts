import type { DatabaseSync } from 'node:sqlite'
import type { RunEventLogCallbacks } from './RunEventLog'
import { RunEventLog } from './RunEventLog'
import { RunEventProjector } from './RunEventProjector'
import { RunEventQueries } from './RunEventQueries'
import { RunEventStore } from './RunEventStore'

export interface CreateRunEventLogOptions extends RunEventLogCallbacks {
  conversationsDirectory: string
  database: DatabaseSync
}

export function createRunEventLog(options: CreateRunEventLogOptions): RunEventLog {
  const queries = new RunEventQueries(options.database)
  return new RunEventLog({
    onObserverError: options.onObserverError,
    onFatalFailure: options.onFatalFailure,
    projector: new RunEventProjector(options.database),
    queries,
    store: new RunEventStore({
      conversationsDirectory: options.conversationsDirectory,
      resolveConversationId: runId => queries.findConversationId(runId),
    }),
  })
}
