import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionDataSource } from '@buddy-shared/extensions/extensionData'
import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { ExtensionDataBinding, ExtensionDataPort } from '@/modules/extensions'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { shallowRef, watch } from 'vue'

export function createWorkbenchDataPort(options: { api: LocalChatApi, controller: WorkbenchController, pool: TaskWorkspacePool }): ExtensionDataPort {
  const { api, controller, pool } = options
  function task(input: ExtensionViewInput) {
    const pane = input.instanceId ? controller.pane(input.instanceId) : null
    const view = pane?.view ? controller.layout.views[pane.view] : null
    return view?.resource.scheme === 'task' ? pool.peek(view.resource) : undefined
  }
  function binding(input: ExtensionViewInput, source: ExtensionDataSource): ExtensionDataBinding | null {
    const current = task(input)
    if (!current || current.workspace.restoration.state.value !== 'ready')
      return null
    const conversationId = current.session.activeTaskId.value
    const branchId = current.workspace.session.activeBranchId.value
    if (!conversationId || !branchId)
      return null
    const runtime = current.workspace.status.runtimeState.value.status
    if (source === 'task.metrics') {
      return {
        key: JSON.stringify([conversationId, branchId, runtime]),
        read: async () => {
          if (runtime !== 'ready')
            return { source, status: 'unavailable', value: null }
          const { conversationId: taskId, ...metrics } = await api.runs.metrics({ conversationId, branchId })
          if (taskId !== conversationId || metrics.branchId !== branchId)
            return { source, status: 'unavailable', value: null }
          return { source, status: 'ready', value: { taskId, ...metrics } }
        },
      }
    }
    const target = current.contextTarget.value
    if (!target?.actorId || target.conversationId !== conversationId || target.branchId !== branchId)
      return null
    const actorId = target.actorId
    return {
      key: JSON.stringify([runtime, target]),
      read: async () => {
        if (runtime !== 'ready')
          return { source, status: 'unavailable', value: null }
        const snapshot = await api.context.getUsageSnapshot(target)
        if (snapshot.status !== 'ready' || snapshot.contextWindow <= 0)
          return { source, status: 'unavailable', value: null }
        return { source, status: 'ready', value: { taskId: conversationId, branchId, actorId, runId: target.runId ?? null, tokens: snapshot.totalTokens, window: snapshot.contextWindow, percent: snapshot.totalTokens / snapshot.contextWindow * 100 } }
      },
    }
  }
  return {
    binding,
    observeChanges(input, listener) {
      const revision = shallowRef(0)
      const invalidate = () => {
        revision.value++
      }
      const stopLayout = controller.onDidChangeLayout(invalidate).dispose
      const stopPool = pool.onDidChange(invalidate).dispose
      const stopBinding = watch(() => {
        void revision.value
        return [binding(input, 'task.metrics')?.key, binding(input, 'context.usage')?.key]
      }, listener, { flush: 'sync' })
      const stopMetrics = api.runs.onMetricsChanged((notice) => {
        if (task(input)?.session.activeTaskId.value === notice.conversationId)
          listener()
      })
      return () => {
        stopMetrics()
        stopBinding()
        stopPool()
        stopLayout()
      }
    },
  }
}
