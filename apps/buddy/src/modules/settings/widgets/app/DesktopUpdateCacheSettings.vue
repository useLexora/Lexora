<script setup lang="ts">
import type { DesktopUpdateCacheSummary } from '@buddy-electron/shared/desktopUpdates'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NTooltip, useDialog, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopUpdatesContext } from '@/modules/updates'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { formatFileSize } from '@/shared/lib/formatFileSize'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'

const props = defineProps<{ language: BuddyLocale, directory: string }>()
const { t } = useBuddyI18n(() => props.language)
const updates = useDesktopUpdatesContext()
const api = requireDesktopApi().app.updates
const message = useMessage()
const dialog = useDialog()
const summary = shallowRef<DesktopUpdateCacheSummary | null>(null)
const opening = shallowRef(false)
const clearing = shallowRef(false)
const busy = computed(() => clearing.value || ['downloading', 'verifying', 'installing'].includes(updates.state.value?.delivery?.status ?? ''))
const options = computed(() => [{ key: 'clear', label: t('desktop.update.clearCache'), disabled: busy.value || !summary.value?.files }])
let generation = 0
let disposed = false
let confirmation: ReturnType<typeof dialog.warning> | null = null
onScopeDispose(() => {
  disposed = true
  generation++
  confirmation?.destroy()
})

async function load() {
  const current = ++generation
  try {
    const next = await api.getCacheSummary()
    if (!disposed && current === generation)
      summary.value = next
  }
  catch {
    if (!disposed && current === generation)
      summary.value = null
  }
}
watch(() => updates.state.value?.delivery?.status, load, { immediate: true })

async function openDirectory() {
  if (opening.value)
    return
  opening.value = true
  try {
    await api.openDownloadDirectory()
  }
  catch {
    if (!disposed)
      message.error(t('desktop.command.failed'))
  }
  finally {
    opening.value = false
  }
}

function clearCache() {
  if (busy.value || !summary.value?.files)
    return
  confirmation = dialog.warning({
    title: t('desktop.update.clearCache'),
    content: t('desktop.update.clearCacheDescription', { size: formatFileSize(summary.value.bytes) }),
    positiveText: t('desktop.update.clearCache'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      if (disposed)
        return false
      clearing.value = true
      try {
        await api.clearCache()
        await load()
        if (!disposed && summary.value?.files)
          message.warning(t('desktop.update.cacheRemaining'))
        return true
      }
      catch {
        await load()
        if (!disposed)
          message.error(t('desktop.update.clearCacheFailed'))
        return false
      }
      finally {
        clearing.value = false
      }
    },
    onAfterLeave: () => { confirmation = null },
  })
}
</script>

<template>
  <DesktopSettingRow :label="t('desktop.update.downloadDirectory')" toggle>
    <template #labelExtra>
      <span v-if="summary?.files" class="text-muted text-[0.7rem]">{{ formatFileSize(summary.bytes) }}</span>
    </template>
    <template #hint>
      <small class="text-muted font-mono text-[0.7rem] leading-[1.5] [overflow-wrap:anywhere]">{{ directory }}</small>
    </template>
    <template #default="{ controlAttrs }">
      <NButton :aria-describedby="controlAttrs['aria-labelledby']" size="small" :loading="opening" :disabled="opening" @click="openDirectory">
        {{ t('desktop.update.openDownloadDirectory') }}
      </NButton>
      <NDropdown :menu-props="() => ({ role: 'menu' })" :node-props="option => ({ 'role': 'menuitem', 'aria-disabled': option.disabled ? 'true' : 'false' })" trigger="click" :options="options" @select="clearCache">
        <NTooltip>
          <template #trigger>
            <NButton class="buddy-icon-button" quaternary size="small" :aria-label="t('desktop.update.cacheActions')" :disabled="busy">
              <template #icon>
                <DesktopIcon :component="MoreHorizontal20Regular" :size="18" />
              </template>
            </NButton>
          </template>
          {{ t('desktop.update.cacheActions') }}
        </NTooltip>
      </NDropdown>
    </template>
  </DesktopSettingRow>
</template>
