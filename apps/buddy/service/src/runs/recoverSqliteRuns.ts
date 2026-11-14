import type { DatabaseSync } from 'node:sqlite'
import { inspectCommittedPiCompaction } from '../agent/sessions/recovery/inspectCommittedPiCompaction'
import { SqliteRunEventLog } from '../events/SqliteRunEventLog'
import { createApprovalRepository } from '../storage/approvalRepository'
import { createChatQueueRepository } from '../storage/chatQueueRepository'
import { createConversationRepository } from '../storage/conversationRepository'
import { createRunRepository } from '../storage/runRepository'
import { requireSqliteAuthority } from '../storage/sqliteAuthority'
import { guardStorageDatabase } from '../storage/StorageIsolation'
import { withTransaction } from '../storage/transaction'
import { createUsageRepository } from '../storage/usageRepository'
import { UsageService } from '../usage/UsageService'
import { RunLifecycleService } from './RunLifecycleService'
import { RunRecoveryService } from './RunRecoveryService'

export interface RecoverSqliteRunsOptions {
  database: DatabaseSync
  conversationsDirectory: string
  captureInterruptedChanges?: (runId: string) => Promise<void>
}

export async function recoverSqliteRuns(options: RecoverSqliteRunsOptions): Promise<number> {
  const { database } = options
  guardStorageDatabase(database)
  const eventLog = new SqliteRunEventLog({ database })
  const runs = createRunRepository(database)
  const approvals = createApprovalRepository(database)
  const usage = new UsageService({ eventLog, repository: createUsageRepository(database) })
  const lifecycle = new RunLifecycleService({ eventLog, repository: runs })
  try {
    withTransaction(database, () => {
      requireSqliteAuthority(database)
      createChatQueueRepository(database).pause()
    })
    const recovery = new RunRecoveryService({
      conversations: createConversationRepository(database),
      eventLog,
      lifecycle,
      repository: runs,
      usage,
      captureInterruptedChanges: options.captureInterruptedChanges,
      cancelPendingApprovals: async () => {
        const pending = approvals.listPending()
        for (const approval of pending) {
          await eventLog.append({
            runId: approval.runId,
            type: 'approval.resolved',
            payload: { id: approval.id, resolution: 'cancelled', status: 'cancelled', resolvedAt: new Date().toISOString() },
          })
        }
        return pending.length
      },
      inspectCommittedCompaction: run => inspectCommittedPiCompaction({
        conversationsDirectory: options.conversationsDirectory,
        conversationId: run.conversationId,
        branchId: run.branchId,
        piSessionFile: run.piSessionFile!,
        startedAt: run.startedAt,
      }),
    })
    const recovered = await recovery.recoverInterruptedRuns()
    await eventLog.compactTerminalRuns()
    return recovered
  }
  finally {
    usage.dispose()
    await lifecycle.dispose()
    await eventLog.close()
  }
}
