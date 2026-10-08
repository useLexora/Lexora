import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { Ref } from 'vue'
import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { computed, onScopeDispose, shallowRef } from 'vue'

export function useTaskResourceSpaces(options: {
  controller: WorkbenchController
  pool: TaskWorkspacePool
  tasks: Readonly<Ref<ReadonlyArray<Pick<LocalConversationSummary, 'id' | 'spaceId'>>>>
}) {
  const { controller, pool } = options
  const openTasks = shallowRef(collect())
  function collect() {
    return Object.values(controller.layout.views)
      .filter(view => view.resource.scheme === 'task' || view.resource.scheme === 'draft')
      .map(({ resource }) => ({ resource, task: pool.peek(resource) }))
  }
  function reconcile() {
    openTasks.value = collect()
  }
  onScopeDispose(pool.onDidChange(reconcile).dispose)
  onScopeDispose(controller.onDidChangeLayout((change) => {
    if (change.changedViewIds.length || change.removedViewIds.length || change.kind === 'restored')
      reconcile()
  }).dispose)
  return computed<ReadonlyMap<string, string | null>>(() => {
    const spaces = new Map(options.tasks.value.map(task => [`task:${task.id}`, task.spaceId]))
    for (const { resource, task } of openTasks.value) {
      const key = `${resource.scheme}:${resource.id}`
      if (spaces.has(key))
        continue
      if (task)
        spaces.set(key, task.session.spaceId.value)
      else if (resource.scheme === 'draft')
        spaces.set(key, typeof resource.data.spaceId === 'string' ? resource.data.spaceId : null)
    }
    return spaces
  })
}
