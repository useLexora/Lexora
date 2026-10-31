import type { DesktopAppInfo } from '@buddy-electron/shared/desktopApi'
import type { FeatureDiscoveryState, FeatureGuideId } from '@buddy-shared/onboarding/featureDiscovery'
import type { Ref } from 'vue'
import type { FeatureGuideStep } from '../model/featureGuideSteps'
import type { ApplicationSettings } from '@/modules/settings/contracts'
import { advanceFeatureDiscovery, availableFeatureGuides, FEATURE_GUIDES } from '@buddy-shared/onboarding/featureDiscovery'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { featureGuideSteps } from '../model/featureGuideSteps'

export function useFeatureDiscovery(options: {
  settings: ApplicationSettings
  appInfo: Readonly<Ref<DesktopAppInfo | null>>
  visit: (id: FeatureGuideId) => Promise<boolean>
  onError: () => void
}) {
  const { settings, appInfo } = options
  const opened = shallowRef(false)
  const session = shallowRef<{ steps: FeatureGuideStep[], index: number } | null>(null)
  const navigating = shallowRef(false)
  const active = computed(() => navigating.value ? null : session.value?.steps[session.value.index] ?? null)
  const progress = computed(() => session.value ? { current: session.value.index + 1, total: session.value.steps.length } : null)
  const busy = shallowRef(false)
  const initialized = shallowRef(false)
  const state = computed(() => settings.config.value?.desktop.featureDiscovery)
  const announcementsEnabled = computed(() => settings.config.value?.desktop.featureAnnouncementsEnabled ?? true)
  const releasedFeatures = computed(() => availableFeatureGuides(appInfo.value?.version ?? ''))
  const features = computed(() => import.meta.env.DEV && appInfo.value && !appInfo.value.isPackaged ? FEATURE_GUIDES : releasedFeatures.value)
  const unread = computed(() => releasedFeatures.value.filter(feature => state.value?.pending.includes(feature.id)))
  const unannounced = computed(() => unread.value.filter(feature => !state.value?.notified.includes(feature.id)))
  let disposed = false
  let initialization: Promise<boolean> | undefined
  let tail = Promise.resolve(true)

  function persist(change: (current: FeatureDiscoveryState) => FeatureDiscoveryState) {
    const operation = async () => {
      if (disposed || !state.value)
        return false
      const current = { version: state.value.version, pending: [...state.value.pending], notified: [...state.value.notified] }
      const next = change(current)
      if (next === current)
        return true
      busy.value = true
      try {
        const saved = await settings.updateSettings({ desktop: { featureDiscovery: next } })
        if (!saved && !disposed)
          options.onError()
        return saved
      }
      finally { busy.value = false }
    }
    tail = tail.then(operation, operation)
    return tail
  }

  function initialize() {
    if (initialized.value)
      return Promise.resolve(true)
    if (!state.value || !appInfo.value)
      return Promise.resolve(false)
    return initialization ??= persist(current => advanceFeatureDiscovery(current, appInfo.value!.version, settings.config.value!.desktop.onboardingCompleted === false))
      .then((saved) => {
        initialized.value = saved
        return saved
      })
      .finally(() => initialization = undefined)
  }
  watch([appInfo, () => !!settings.config.value], () => void initialize(), { immediate: true })

  function dismissReminder() {
    return persist(current => unannounced.value.length ? { ...current, notified: [...new Set([...current.notified, ...unread.value.map(feature => feature.id)])] } : current)
  }
  async function open() {
    if (!await initialize() || disposed)
      return
    finish()
    opened.value = true
    await dismissReminder()
  }
  async function showStep(next: NonNullable<typeof session.value>) {
    if (busy.value || disposed)
      return
    const step = next.steps[next.index]
    if (!step)
      return
    busy.value = true
    navigating.value = true
    try {
      if (await options.visit(step.featureId)) {
        session.value = next
        opened.value = false
      }
    }
    catch { options.onError() }
    finally {
      navigating.value = false
      busy.value = false
    }
  }
  function visit(id: FeatureGuideId) {
    return showStep({ steps: featureGuideSteps([id]), index: 0 })
  }
  function startRelease(version: string) {
    return showStep({ steps: featureGuideSteps(features.value.filter(feature => feature.version === version).map(feature => feature.id)), index: 0 })
  }
  function next() {
    const current = session.value
    if (!current || busy.value)
      return
    if (current.index + 1 === current.steps.length)
      finish()
    else
      return showStep({ ...current, index: current.index + 1 })
  }
  function previous() {
    const current = session.value
    if (current && current.index > 0)
      return showStep({ ...current, index: current.index - 1 })
  }
  function arrived(id: FeatureGuideStep['id']) {
    const current = session.value
    const step = active.value
    if (!current || !step || step.id !== id || !unread.value.some(feature => feature.id === step.featureId))
      return
    if (current.steps[current.index + 1]?.featureId === step.featureId)
      return
    void persist(value => ({ ...value, pending: value.pending.filter(value => value !== step.featureId) }))
  }
  function unavailable() {
    finish()
    options.onError()
  }
  function finish() {
    session.value = null
  }
  function routeChanged() {
    if (!navigating.value)
      finish()
  }
  onScopeDispose(() => disposed = true)
  return { opened, active, progress, busy, initialized, announcementsEnabled, unavailable, features, unread, unannounced, open, visit, startRelease, next, previous, arrived, finish, routeChanged, dismissReminder }
}

export type FeatureDiscovery = ReturnType<typeof useFeatureDiscovery>
