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
const { details } = updates
const windowFocused = useWindowFocus()
const visibility = useDocumentVisibility()
const focused = computed(() => windowFocused.value && visibility.value === 'visible')
const { reminder, dismiss } = useUpdateReminder(updates, focused, api.localChat)
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const pending = shallowRef(false)

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
  />
  <DesktopUpdateDialog
    :show="details !== null"
    :result="details"
    :language="language"
    :pending="pending"
    :write-clipboard-text="api.clipboard.writeText"
    @update:show="!$event && updates.closeDetails()"
    @open-release="url => action(() => api.app.openReleasePage(url))"
    @ignore="version => action(() => updates.ignore(version))"
  />
</template>
