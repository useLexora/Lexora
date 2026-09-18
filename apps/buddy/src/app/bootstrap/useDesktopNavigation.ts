import type { DesktopOpenTarget } from '@buddy-electron/shared/desktopApi'
import type { LocalNotification } from '@buddy-shared/notifications/notificationApi'
import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { RouteLocationRaw, Router } from 'vue-router'
import type { NotificationCenterStore } from '@/modules/notifications'
import type { TaskSession } from '@/modules/tasks/contracts'
import { useTimeoutFn } from '@vueuse/core'
import { onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'

interface DesktopNavigationOptions {
  router: Router
  ready: Promise<void>
  session: Pick<TaskSession, 'activeTaskId' | 'spaceId' | 'navigationVersion' | 'openTask' | 'startTask'>
  notifications: Pick<NotificationCenterStore, 'markSeen'>
  getRun: (runId: string) => Promise<RunTarget | null>
  activateRunBranch: (run: RunTarget) => Promise<boolean>
  onError: (error: unknown) => void
}

type RunTarget = Pick<LocalRun, 'conversationId' | 'branchId' | 'triggeringMessageId'>

export function useDesktopNavigation(options: DesktopNavigationOptions) {
  const { router, session } = options
  const notificationTarget = shallowRef<{ conversationId: string, messageId: string } | null>(null)
  const highlightTimer = useTimeoutFn(() => notificationTarget.value = null, 3_000, { immediate: false })
  let pending: { controller: AbortController, taskId: string | null, spaceId?: string, version: number } | null = null
  let disposed = false

  function cancel() {
    pending?.controller.abort()
    pending = null
    highlightTimer.stop()
    notificationTarget.value = null
  }

  const stopNavigationGuard = router.beforeEach((to) => {
    if (to.path !== router.resolve(desktopRouteLocations.tasks()).path)
      cancel()
  })
  watch([session.activeTaskId, session.spaceId], ([taskId, spaceId]) => {
    if (pending && session.navigationVersion() !== pending.version && (taskId !== pending.taskId || (pending.spaceId !== undefined && spaceId !== pending.spaceId)))
      cancel()
  })
  onScopeDispose(() => {
    disposed = true
    cancel()
    stopNavigationGuard()
  })

  async function navigate(location: RouteLocationRaw) {
    cancel()
    if (disposed)
      return
    try {
      await router.push(location)
    }
    catch (error) {
      if (!disposed)
        options.onError(error)
    }
  }

  async function openTask(conversationId: string, runId?: string) {
    await openWorkspace({ taskId: conversationId }, async (signal) => {
      await session.openTask(conversationId, signal)
      if (signal.aborted || session.activeTaskId.value !== conversationId || !runId)
        return
      const run = await options.getRun(runId)
      if (signal.aborted || session.activeTaskId.value !== conversationId || run?.conversationId !== conversationId)
        return
      if (!await options.activateRunBranch(run) || signal.aborted || session.activeTaskId.value !== conversationId)
        return
      notificationTarget.value = { conversationId, messageId: run.triggeringMessageId }
      highlightTimer.start()
    })
  }

  async function openSpace(spaceId: string) {
    await openWorkspace({ taskId: null, spaceId }, () => session.startTask(spaceId))
  }

  async function openWorkspace(target: { taskId: string | null, spaceId?: string }, activate: (signal: AbortSignal) => Promise<void>) {
    cancel()
    if (disposed)
      return
    const controller = new AbortController()
    pending = { ...target, controller, version: session.navigationVersion() }
    try {
      await router.push(desktopRouteLocations.tasks())
      await options.ready
      if (!controller.signal.aborted) {
        await activate(controller.signal)
      }
    }
    catch (error) {
      if (!controller.signal.aborted)
        options.onError(error)
    }
  }

  function openNotification(notification: LocalNotification) {
    void options.notifications.markSeen(notification)
    return notification.action.type === 'open-model-settings'
      ? navigate(desktopRouteLocations.settings('models'))
      : openTask(notification.action.conversationId, notification.action.runId)
  }

  function openTarget(target: DesktopOpenTarget) {
    return openTask(target.conversationId, target.runId)
  }

  return { navigate, notificationTarget: readonly(notificationTarget), openNotification, openSpace, openTarget, openTask }
}

export type DesktopNavigation = ReturnType<typeof useDesktopNavigation>
