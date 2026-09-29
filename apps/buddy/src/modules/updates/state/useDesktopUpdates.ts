import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { DesktopUpdateCheckResult, DesktopUpdateState } from '@buddy-electron/shared/desktopUpdates'
import { readonly, shallowRef } from 'vue'

export function useDesktopUpdates(app: Pick<LexoraDesktopApi['app'], 'checkForUpdates' | 'updates'>) {
  const state = shallowRef<DesktopUpdateState | null>(null)
  const details = shallowRef<DesktopUpdateCheckResult | null>(null)
  let disposed = false
  let generation = 0
  const stop = app.updates.onChanged(apply)

  function apply(next: DesktopUpdateState) {
    if (!disposed && (!state.value || next.revision >= state.value.revision))
      state.value = next
  }

  async function load() {
    const next = await app.updates.getState()
    apply(next)
  }

  async function markSeen(version: string) {
    apply(await app.updates.acknowledge({ action: 'seen', version }))
  }

  async function markReminded(version: string) {
    apply(await app.updates.acknowledge({ action: 'reminded', version }))
  }

  async function openDetails() {
    generation++
    const result = state.value?.result
    if (disposed || !result)
      return
    details.value = result
    if (result.status === 'update_available')
      await markSeen(result.latestVersion)
  }

  async function check() {
    const current = ++generation
    const result = await app.checkForUpdates()
    if (!disposed && current === generation)
      details.value = result
  }

  async function ignore(version: string) {
    apply(await app.updates.acknowledge({ action: 'ignore', version }))
    if (details.value?.latestVersion === version)
      closeDetails()
  }

  function closeDetails() {
    generation++
    details.value = null
  }

  function dispose() {
    disposed = true
    generation++
    stop()
  }

  return { state: readonly(state), details: readonly(details), load, check, openDetails, closeDetails, markSeen, markReminded, ignore, takeReminder: app.updates.takeReminder, dispose }
}
