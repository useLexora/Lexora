import type { DesktopUpdateCheckResult } from '@buddy-electron/shared/desktopUpdates'
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { Ref } from 'vue'
import type { DesktopUpdates } from '../contracts'
import { nextTick, onScopeDispose, readonly, shallowRef, watch } from 'vue'

export function useUpdateReminder(updates: DesktopUpdates, focused: Readonly<Ref<boolean>>, chat: { chat: Pick<LocalChatApi['chat'], 'onRunEvent'> }) {
  const reminder = shallowRef<DesktopUpdateCheckResult | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let disposed = false
  let activityRevision = 0

  function schedule(delay = 0) {
    clearTimeout(timer)
    const due = updates.state.value?.reminderDueAt
    if (disposed || !focused.value || updates.details.value || reminder.value || due == null)
      return
    timer = setTimeout(() => void attempt(), Math.max(delay, due - Date.now(), 0))
  }

  function canShow(result: DesktopUpdateCheckResult, activity: number) {
    const notification = updates.state.value?.notification
    return !disposed && focused.value && activity === activityRevision && !updates.details.value
      && updates.state.value?.reminderDueAt != null
      && notification?.revision === result.latestVersion && notification.attention === 'unseen'
  }

  async function attempt() {
    if (pending || disposed)
      return
    pending = true
    const activity = activityRevision
    try {
      const result = await updates.takeReminder()
      if (!result || !canShow(result, activity))
        return
      reminder.value = result
      await nextTick()
      if (reminder.value === result && canShow(result, activity))
        await updates.markReminded(result.latestVersion)
      else if (reminder.value === result)
        reminder.value = null
    }
    catch {}
    finally {
      pending = false
      schedule(30_000)
    }
  }

  const stopRuns = chat.chat.onRunEvent((event) => {
    if (event.type === 'run.started' || event.type === 'approval.requested') {
      activityRevision++
      reminder.value = null
    }
    if (/^run\.(?:completed|failed|cancelled)$/.test(event.type) || event.type === 'approval.resolved')
      schedule(1000)
  })
  watch([updates.state, updates.details, focused], () => {
    if (!focused.value || updates.details.value || updates.state.value?.notification?.revision !== reminder.value?.latestVersion
      || updates.state.value?.notification?.attention === 'seen') {
      reminder.value = null
    }
    schedule()
  }, { immediate: true })
  onScopeDispose(() => {
    disposed = true
    clearTimeout(timer)
    stopRuns()
  })
  function dismiss() {
    reminder.value = null
  }
  return { reminder: readonly(reminder), dismiss }
}
