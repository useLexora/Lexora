import type { PairedDevice, PairingCode, PrivateNetworkStatus } from '@buddy-shared/privateNetwork/management'
import { useIntervalFn, useNow } from '@vueuse/core'
import { useMessage } from 'naive-ui'
import { computed, onMounted, onScopeDispose, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { useSettingsContext } from '../../settingsContext'

export function usePrivateNetworkSettings() {
  const { applicationSettings: { language } } = useSettingsContext()
  const { t } = useBuddyI18n(language)
  const api = requireDesktopApi().localChat.privateNetwork
  const message = useMessage()
  const status = shallowRef<PrivateNetworkStatus | null>(null)
  const devices = shallowRef<PairedDevice[]>([])
  const pairing = shallowRef<PairingCode | null>(null)
  const busy = shallowRef(false)
  const unavailable = shallowRef(false)
  const now = useNow({ scheduler: update => useIntervalFn(update, 1000) })
  const seconds = computed(() => pairing.value ? Math.max(0, Math.ceil((Date.parse(pairing.value.expiresAt) - now.value.getTime()) / 1000)) : 0)
  const qr = computed(() => pairing.value && seconds.value > 0 ? JSON.stringify(pairing.value) : '')
  let disposed = false
  let refreshing = false
  let revision = 0
  async function refresh() {
    if (refreshing || disposed || busy.value)
      return
    refreshing = true
    const requestedRevision = revision
    try {
      const [next, paired] = await Promise.all([api.status({}), api.devices({})])
      if (disposed || requestedRevision !== revision)
        return
      status.value = next
      devices.value = paired
      unavailable.value = false
      if (next.state !== 'listening')
        pairing.value = null
    }
    catch {
      if (!disposed && requestedRevision === revision)
        unavailable.value = true
    }
    finally { refreshing = false }
  }
  async function act(operation: () => Promise<unknown>) {
    if (busy.value)
      return
    busy.value = true
    revision++
    try {
      await operation()
      return true
    }
    catch {
      if (!disposed)
        message.error(t('desktop.settings.devices.failed'))
      return false
    }
    finally {
      busy.value = false
      await refresh()
    }
  }
  async function configure(enabled: boolean) {
    return act(async () => {
      await cancelPairing()
      const next = await api.configure({ enabled })
      if (!disposed)
        status.value = next
    })
  }
  async function cancelPairing() {
    const current = pairing.value
    pairing.value = null
    if (current)
      await api.cancelPairing({ ticketId: current.ticketId })
  }
  async function issuePairing() {
    await act(async () => {
      await cancelPairing()
      const issued = await api.issuePairing({})
      if (disposed)
        await api.cancelPairing({ ticketId: issued.ticketId })
      else pairing.value = issued
    })
  }
  onMounted(() => refresh())
  useIntervalFn(() => refresh(), 5000)
  onScopeDispose(() => {
    disposed = true
    void cancelPairing().catch(() => {})
  })

  return { t, api, status, devices, pairing, busy, unavailable, seconds, qr, refresh, act, configure, cancelPairing, issuePairing }
}
