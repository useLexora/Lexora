import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionBrief, ExecutionContextMode } from '../../../shared/executions/executionWork'
import { executionBriefSchema, executionContextModeSchema, executionReviewSchema, executionSubmissionSchema } from '../../../shared/executions/executionWork'

export function createExecutionWorkRepository(database: DatabaseSync) {
  function find(runId: string) {
    const row = database.prepare('SELECT * FROM execution_work_attempts WHERE run_id = ?').get(runId)
    if (!row)
      return null
    return {
      runId,
      workId: row.work_id as string,
      previousRunId: row.previous_run_id as string | null,
      contextMode: executionContextModeSchema.parse(row.context_mode),
      contextSourceIds: JSON.parse(row.context_source_ids_json as string) as string[],
      brief: row.brief_json ? executionBriefSchema.parse(JSON.parse(row.brief_json as string)) : null,
      submission: row.submission_json ? executionSubmissionSchema.parse(JSON.parse(row.submission_json as string)) : null,
      review: row.review_json ? executionReviewSchema.parse(JSON.parse(row.review_json as string)) : null,
    }
  }
  return {
    find,
    configure(runId: string, input: { previousRunId?: string, contextMode: ExecutionContextMode, contextSourceIds: readonly string[], brief?: ExecutionBrief }) {
      const previous = input.previousRunId ? find(input.previousRunId) : null
      if (input.previousRunId && !previous)
        throw new Error('Execution work is unavailable')
      database.prepare(`UPDATE execution_work_attempts SET work_id = ?, previous_run_id = ?, context_mode = ?, context_source_ids_json = ?, brief_json = ? WHERE run_id = ?`)
        .run(previous?.workId ?? runId, input.previousRunId ?? null, input.contextMode, JSON.stringify(input.contextSourceIds), input.brief || previous?.brief ? JSON.stringify(input.brief ?? previous?.brief) : null, runId)
    },
    successor(runId: string): string | null {
      return database.prepare('SELECT run_id FROM execution_work_attempts WHERE previous_run_id = ?').get(runId)?.run_id as string | undefined ?? null
    },
  }
}

export type ExecutionWorkRecord = NonNullable<ReturnType<ReturnType<typeof createExecutionWorkRepository>['find']>>
