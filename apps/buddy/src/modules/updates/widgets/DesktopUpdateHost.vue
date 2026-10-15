<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useDocumentVisibility, useWindowFocus } from '@vueuse/core'
import { useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { useUpdateReminder } from '../state/useUpdateReminder'
import { useDesktopUpdatesContext } from '../updatesContext'
import DesktopUpdateDialog from './DesktopUpdateDialog.vue'
import DesktopUpdateReminder from './DesktopUpdateReminder.vue'

const props = defineProps<{ language: BuddyLocale }>()
const api = requireDesktopApi()
const updates = useDesktopUpdatesContext()
const { details, state } = updates
const windowFocused = useWindowFocus()
const visibility = useDocumentVisibility()
const focused = computed(() => windowFocused.value && visibility.value === 'visible')
const { reminder, dismiss } = useUpdateReminder(updates, focused, api.localChat)
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const pending = shallowRef(false)
const downloadingVersion = shallowRef<string | null>(null)
const delivery = computed(() => {
  const current = state.value?.delivery
  if (current && current.version === downloadingVersion.value && ['available', 'error'].includes(current.status))
    return { ...current, status: 'downloading' as const, progressPercent: 0, downloadedBytes: 0, failure: undefined }
  return current
})

async function download() {
  const version = details.value?.latestVersion
  if (!version || pending.value || downloadingVersion.value)
    return
  downloadingVersion.value = version
  try {
    await api.app.updates.download(version)
  }
  catch {
    if (state.value?.result?.latestVersion === version)
      message.error(t(state.value?.delivery?.failure === 'verification' ? 'desktop.update.verificationFailed' : 'desktop.update.downloadFailed'))
  }
  finally {
    if (downloadingVersion.value === version)
      downloadingVersion.value = null
  }
}

async function action(operation: () => Promise<unknown>) {
  if (pending.value)
    return
  pending.value = true
  try {
    await operation()
  }
  catch {
    message.error(t('desktop.command.failed'))
  }
  finally {
    pending.value = false
  }
}

function versionedAction(operation: (version: string) => Promise<unknown>) {
  const version = details.value?.latestVersion
  if (version)
    return action(() => operation(version))
}
</script>

<template>
  <DesktopUpdateReminder
    v-if="reminder && focused"
    :result="reminder"
    :language="language"
    :pending="pending"
    @dismiss="dismiss"
    @open="action(updates.openDetails)"
    @ignore="version => action(() => updates.ignore(version))"
    @snooze="(version, delay) => action(() => updates.snooze(version, delay))"
  />
  <DesktopUpdateDialog
    :show="details !== null"
    :result="details"
    :delivery="delivery"
    :ignored="state?.ignoredVersion === details?.latestVersion"
    :check-failed="state?.checkFailed"
    :reminder-deferred-until="state?.result?.latestVersion === details?.latestVersion ? state?.reminderDeferredUntil : null"
    :latest-version="state?.result?.latestVersion"
    :language="language"
    :pending="pending"
    :write-clipboard-text="api.clipboard.writeText"
    @update:show="!$event && updates.closeDetails()"
    @open-release="url => action(() => api.app.openReleasePage(url))"
    @ignore="version => action(() => updates.ignore(version))"
    @restore="version => action(() => updates.restore(version))"
    @cancel-snooze="version => action(() => updates.cancelSnooze(version))"
    @snooze="(version, delay) => action(() => updates.snooze(version, delay))"
    @show-latest="action(updates.openDetails)"
    @download="download"
    @cancel-download="versionedAction(api.app.updates.cancelDownload)"
    @install="versionedAction(api.app.updates.install)"
    @open-package="versionedAction(api.app.updates.openPackage)"
    @open-download-directory="action(api.app.updates.openDownloadDirectory)"
  />
</template>
