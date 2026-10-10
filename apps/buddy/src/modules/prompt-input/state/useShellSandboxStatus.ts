import type { SandboxEnvironmentStatus, SandboxSetupResult } from '@buddy-shared/permissions/shellSandbox'
import type { Ref } from 'vue'
import { sandboxAvailability, sandboxEnvironmentStatusSchema, sandboxSetupResultSchema } from '@buddy-shared/permissions/shellSandbox'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'

export function useShellSandboxStatus(open: Ref<boolean>) {
  const status = shallowRef<SandboxEnvironmentStatus | 'unknown' | 'checking'>('checking')
  const isChecking = shallowRef(false)
  const isSettingUp = shallowRef(false)
  const setupResult = shallowRef<SandboxSetupResult>()
  const availability = computed(() => sandboxAvailability(status.value))
  let disposed = false
  let revision = 0
  onScopeDispose(() => {
    disposed = true
  })

  async function refresh() {
    const current = ++revision
    isChecking.value = true
    try {
      const desktop = window.lexoraDesktop
      if (!desktop)
        throw new Error('Desktop API is unavailable')
      const next = sandboxEnvironmentStatusSchema.parse(await desktop.app.getSandboxStatus())
      if (!disposed && current === revision)
        status.value = next
    }
    catch {
      if (!disposed && current === revision)
        status.value = 'unknown'
    }
    finally {
      if (!disposed && current === revision)
        isChecking.value = false
    }
  }

  async function recheck() {
    if (isChecking.value || isSettingUp.value)
      return
    setupResult.value = undefined
    await refresh()
  }

  async function setup() {
    if (disposed || isSettingUp.value || !availability.value.action)
      return
    isSettingUp.value = true
    setupResult.value = undefined
    revision++
    isChecking.value = false
    try {
      const result = sandboxSetupResultSchema.parse(await window.lexoraDesktop?.app.setupSandbox())
      if (disposed)
        return
      setupResult.value = result
      if (result === 'ready')
        status.value = 'available'
      else if (result === 'incompatible')
        status.value = 'incompatible'
      else
        await refresh()
      return disposed ? undefined : result
    }
    catch {
      if (!disposed) {
        setupResult.value = 'failed'
        await refresh()
      }
    }
    finally {
      if (!disposed)
        isSettingUp.value = false
    }
  }

  watch(open, (visible) => {
    if ((visible || status.value === 'checking') && !isSettingUp.value)
      void refresh()
  }, { immediate: true })
  return { availability, isChecking, isSettingUp, setupResult, recheck, setup }
}
