import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { Ref } from 'vue'
import type { TaskExecutionTree } from '../../contracts'
import type { ActorInputTarget } from '../composer/useActorInputTarget'
import { actorThreadId } from '@buddy-shared/conversation/actorThread'
import { computed } from 'vue'
import { useChatContextUsage } from './useChatContextUsage'

type TaskContextUsageOptions = Omit<Parameters<typeof useChatContextUsage>[0], 'actorId' | 'runId' | 'threadId' | 'runRevision'> & {
  actorInput: ActorInputTarget
  executionTree: Pick<TaskExecutionTree, 'records'>
  runs: Readonly<Ref<readonly LocalRun[]>>
}

export function useTaskContextUsage(options: TaskContextUsageOptions) {
  const { actorInput, executionTree, runs, runSignalEvents, activeConversationId, activeBranchId } = options
  const actorId = actorInput.actorId
  const runId = computed(() => actorInput.delivery.value?.mode === 'current'
    && actorInput.execution.value?.buddyId === actorId.value
    ? actorInput.target.value?.runId ?? null
    : null)
  const threadId = computed(() => runId.value
    ? actorInput.execution.value?.threadId ?? null
    : activeConversationId.value && actorId.value
      ? actorThreadId(activeConversationId.value, actorId.value, activeBranchId.value ?? undefined)
      : null)
  const actorRunIds = computed(() => {
    if (runId.value)
      return new Set([runId.value])
    const branchRootIds = new Set(runs.value.filter(run => run.conversationId === activeConversationId.value
      && run.branchId === activeBranchId.value).map(run => run.id))
    return new Set(executionTree.records.value.filter(run => run.buddyId === actorId.value
      && run.threadId === threadId.value && branchRootIds.has(run.rootRunId)).map(run => run.runId))
  })
  const maintenanceRunIds = computed(() => new Set(runs.value
    .filter(run => run.buddyId === actorId.value && run.purpose === 'conversation.compaction')
    .map(run => run.id)))
  const runRevision = computed(() => JSON.stringify([
    runId.value ? executionTree.records.value.find(run => run.runId === runId.value)?.updatedAt ?? null : null,
    runs.value.filter(run => maintenanceRunIds.value.has(run.id)).map(run => [run.id, run.status, run.completedAt]),
    runSignalEvents.value.filter(event => event.type === 'context.compaction.completed'
      && maintenanceRunIds.value.has(event.runId)).map(event => [event.runId, event.sequence]),
  ]))
  return useChatContextUsage({
    ...options,
    actorId,
    runId,
    threadId,
    runRevision,
    runSignalEvents: computed(() => runSignalEvents.value.filter(event => actorRunIds.value.has(event.runId))),
  })
}
