import type { DesktopOpenTarget, DesktopOpenTargetResult } from '@buddy-electron/shared/desktopApi'
import type { LocalRun } from '@buddy-shared/runs/runApi'
import type { RouteLocationRaw, Router } from 'vue-router'
import type { NotificationCenterStore } from '@/modules/notifications'
import type { DesktopNotification } from '@/modules/notifications/contracts'
import type { TaskSession } from '@/modules/tasks/contracts'
import { onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'

interface DesktopNavigationOptions {
  router: Router
  ready: Promise<void>
  isReady?: () => boolean
  session: Pick<TaskSession, 'activeTaskId' | 'spaceId' | 'navigationVersion' | 'openTask' | 'startTask'>
  notifications: Pick<NotificationCenterStore, 'markSeen'>
  openUpdate: () => Promise<void>
  getRun: (runId: string) => Promise<RunTarget | null>
  activateRunBranch: (run: RunTarget) => Promise<boolean>
  onError: (error: unknown) => void
}

type RunTarget = Pick<LocalRun, 'conversationId' | 'branchId' | 'triggeringMessageId'>

export function useDesktopNavigation(options: DesktopNavigationOptions) {
  const { router, session } = options
  const notificationTarget = shallowRef<{ conversationId: string, messageId: string } | null>(null)
  let pending: { controller: AbortController, taskId: string | null, spaceId?: string, version: number } | null = null
  let disposed = false
  let finishReveal: ((result: DesktopOpenTargetResult) => void) | null = null

  function cancel() {
    finishReveal?.('cancelled')
    finishReveal = null
    pending?.controller.abort()
    pending = null
    notificationTarget.value = null
  }

  const stopNavigationGuard = router.beforeEach((to) => {
    if (to.path !== router.resolve(desktopRouteLocations.tasks()).path)
      cancel()
  })
  watch([session.activeTaskId, session.spaceId], ([taskId, spaceId]) => {
    if (options.isReady?.() === false)
      return
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

  function completeNotificationReveal(conversationId: string, messageId: string, result: 'opened' | 'cancelled' = 'opened') {
    if (notificationTarget.value?.conversationId !== conversationId || notificationTarget.value.messageId !== messageId)
      return
    finishReveal?.(result)
    finishReveal = null
    notificationTarget.value = null
  }

  async function openTaskTarget(conversationId: string, runId?: string, waitForReveal = false) {
    return openWorkspace({ taskId: conversationId }, async (signal) => {
      await session.openTask(conversationId, signal)
      if (signal.aborted || session.activeTaskId.value !== conversationId)
        return 'cancelled'
      if (!runId)
        return 'opened'
      const run = await options.getRun(runId)
      if (signal.aborted || session.activeTaskId.value !== conversationId)
        return 'cancelled'
      if (run?.conversationId !== conversationId)
        throw new Error('DESKTOP_NOTIFICATION_TARGET_UNAVAILABLE')
      const activated = await options.activateRunBranch(run)
      if (signal.aborted || session.activeTaskId.value !== conversationId)
        return 'cancelled'
      if (!activated)
        throw new Error('DESKTOP_NOTIFICATION_BRANCH_UNAVAILABLE')
      const reveal = Promise.withResolvers<DesktopOpenTargetResult>()
      finishReveal = reveal.resolve
      notificationTarget.value = { conversationId, messageId: run.triggeringMessageId }
      return waitForReveal ? reveal.promise : 'opened'
    })
  }

  async function openTask(conversationId: string, runId?: string) {
    await openTaskTarget(conversationId, runId)
  }

  async function openSpace(spaceId: string) {
    await openWorkspace({ taskId: null, spaceId }, async () => {
      await session.startTask(spaceId)
      return 'opened'
    })
  }

  async function openWorkspace(target: { taskId: string | null, spaceId?: string }, activate: (signal: AbortSignal) => Promise<DesktopOpenTargetResult>): Promise<DesktopOpenTargetResult> {
    cancel()
    if (disposed)
      return 'cancelled'
    const controller = new AbortController()
    pending = { ...target, controller, version: session.navigationVersion() }
    try {
      await router.push(desktopRouteLocations.tasks())
      await options.ready
      if (controller.signal.aborted)
        return 'cancelled'
      if (options.isReady?.() === false)
        throw new Error('DESKTOP_NOTIFICATION_NOT_READY')
      return await activate(controller.signal)
    }
    catch (error) {
      if (controller.signal.aborted)
        return 'cancelled'
      options.onError(error)
      return 'failed'
    }
  }

  async function openNotification(notification: DesktopNotification) {
    if (notification.action.type === 'open-app-update') {
      try {
        await options.openUpdate()
      }
      catch (error) {
        options.onError(error)
      }
      return
    }
    void options.notifications.markSeen(notification)
    return notification.action.type === 'open-model-settings'
      ? navigate(desktopRouteLocations.settings('models'))
      : openTask(notification.action.conversationId, notification.action.runId)
  }

  function openTarget(target: DesktopOpenTarget) {
    return openTaskTarget(target.conversationId, target.runId, true)
  }

  return { navigate, notificationTarget: readonly(notificationTarget), completeNotificationReveal, openNotification, openSpace, openTarget, openTask }
}

export type DesktopNavigation = ReturnType<typeof useDesktopNavigation>
