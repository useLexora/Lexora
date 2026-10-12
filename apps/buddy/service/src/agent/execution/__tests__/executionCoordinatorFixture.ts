import type { DatabaseSync } from 'node:sqlite'
import type { createRunEventLog } from '../../../events/createRunEventLog'
import type { RunLifecycleService } from '../../../runs/RunLifecycleService'
import type { ExecutionCoordinatorOptions } from '../ExecutionCoordinator'
import { MutationCoordinator } from '../../../changes/MutationCoordinator'
import { createMutationRepository } from '../../../changes/mutationRepository'
import { createExecutionRepository } from '../../../storage/executionRepository'
import { createMailboxRepository } from '../../../storage/mailboxRepository'
import { createRunRepository } from '../../../storage/runRepository'
import { ExecutionCoordinator } from '../ExecutionCoordinator'
import { readExecutionResult } from '../readExecutionResult'

export function createTestExecutionCoordinator(options: {
  database: DatabaseSync
  eventLog: ReturnType<typeof createRunEventLog>
  lifecycle: RunLifecycleService
  stopExecution?: ExecutionCoordinatorOptions['stopExecution']
}) {
  const runs = createRunRepository(options.database)
  return new ExecutionCoordinator({
    executions: createExecutionRepository(options.database),
    mailbox: createMailboxRepository(options.database),
    mutations: new MutationCoordinator({ repository: createMutationRepository(options.database) }),
    events: options.eventLog,
    lifecycle: options.lifecycle,
    readResult: runId => readExecutionResult(options.eventLog, runId),
    listIncomplete: () => runs.listIncomplete(),
    launchChild: async () => { throw new Error('This fixture does not launch children') },
    stopExecution: options.stopExecution ?? (async () => false),
  })
}
