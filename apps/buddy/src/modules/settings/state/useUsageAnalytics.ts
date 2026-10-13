import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalUsageAnalytics, LocalUsageTopTasks, UsageTopTasksRequest } from '@buddy-shared/usage/usageAnalyticsApi'
import type { Ref } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, readonly, shallowRef, watch } from 'vue'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { aggregateUsage, localUsageDate, usageDateRange } from '../model/usageAnalytics'
import { useUsageTrend } from './useUsageTrend'

interface UsageAnalyticsOptions {
  api: Pick<LocalChatApi['usage'], 'analytics' | 'topTasks' | 'trend'>
  language: Readonly<Ref<BuddyLocale>>
  runtime: Readonly<Ref<{ status: string }>>
  ready: Promise<void>
}

export function useUsageAnalytics(options: UsageAnalyticsOptions) {
  const period = shallowRef<'recent' | number>('recent')
  const clock = shallowRef(readClock())
  const revision = shallowRef(0)
  const snapshot = shallowRef<LocalUsageAnalytics | null>(null)
  const tasks = shallowRef<LocalUsageTopTasks | null>(null)
  const loading = shallowRef(true)
  const tasksLoading = shallowRef(true)
  const error = shallowRef<string | null>(null)
  const tasksError = shallowRef<string | null>(null)
  const range = computed(() => ({ ...usageDateRange(period.value, clock.value.today), timeZone: clock.value.timeZone }))
  const overview = computed(() => aggregateUsage(snapshot.value?.days ?? []))
  const taskRequest = computed<UsageTopTasksRequest>(() => ({ ...range.value, model: null }))
  const trend = useUsageTrend({ ...options, annual: range, revision })
  const years = computed(() => {
    const current = Number(clock.value.today.slice(0, 4))
    const first = snapshot.value?.firstRecordedAt ? new Date(snapshot.value.firstRecordedAt).getFullYear() : current
    return Array.from({ length: Math.max(1, current - first + 1) }, (_, index) => current - index)
  })

  watch([range, revision, () => options.runtime.value.status], async ([input, , status], _, onCleanup) => {
    let active = true
    onCleanup(() => active = false)
    loading.value = true
    error.value = null
    if (status !== 'ready')
      return
    try {
      await options.ready
      if (!active)
        return
      const result = await options.api.analytics(input)
      if (active)
        snapshot.value = result
    }
    catch (cause) {
      if (active)
        error.value = resolveLocalChatErrorMessage(cause, options.language.value)
    }
    finally {
      if (active)
        loading.value = false
    }
  }, { immediate: true })

  watch([taskRequest, revision, () => options.runtime.value.status], async ([input, , status], _, onCleanup) => {
    let active = true
    onCleanup(() => active = false)
    tasksLoading.value = true
    tasksError.value = null
    tasks.value = null
    if (status !== 'ready')
      return
    try {
      await options.ready
      if (!active)
        return
      const result = await options.api.topTasks(input)
      if (active)
        tasks.value = result
    }
    catch (cause) {
      if (active)
        tasksError.value = resolveLocalChatErrorMessage(cause, options.language.value)
    }
    finally {
      if (active)
        tasksLoading.value = false
    }
  }, { immediate: true })

  function refresh() {
    clock.value = readClock()
    revision.value += 1
  }

  return {
    period: readonly(period),
    snapshot: readonly(snapshot),
    tasks: readonly(tasks),
    loading: readonly(loading),
    tasksLoading: readonly(tasksLoading),
    error: readonly(error),
    tasksError: readonly(tasksError),
    range,
    years,
    overview,
    trend,
    setPeriod: (value: 'recent' | number) => period.value = value,
    refresh,
  }
}

export type UsageAnalyticsState = ReturnType<typeof useUsageAnalytics>

function readClock() {
  return { today: localUsageDate(), timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone }
}
