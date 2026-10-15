<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { BUILTIN_FILE_ICON_THEME } from '@buddy-shared/icons/fileIconTheme'
import { NSelect, useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { desktopFileIconSnapshot as snapshot } from '@/theme/desktopFileIconState'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

const props = defineProps<{ language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const pending = shallowRef(false)
const options = computed(() => {
  const themes = snapshot.value.themes.map(theme => ({
    label: theme.id === BUILTIN_FILE_ICON_THEME ? t('desktop.settings.fileIconsBuiltin') : `${theme.label} · ${theme.packageName}`,
    value: theme.id,
    disabled: false,
  }))
  const selected = snapshot.value.preference.id
  if (!themes.some(theme => theme.value === selected))
    themes.unshift({ label: selected, value: selected, disabled: true })
  return themes
})
async function update(id: string) {
  pending.value = true
  try {
    await requireDesktopApi().fileIcons.request({ action: 'preference', preference: { id } })
  }
  catch { message.error(t('desktop.settings.saveFailed')) }
  finally { pending.value = false }
}
</script>

<template>
  <DesktopSettingsGroup>
    <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.fileIcons')" :description="t('desktop.settings.fileIconsDescription')">
      <NSelect v-bind="controlAttrs" data-testid="desktop-file-icon-select" filterable :options="options" :value="snapshot.preference.id" :disabled="pending" @update:value="update" />
    </DesktopSettingRow>
    <p v-if="snapshot.unavailable" class="m-0 text-xs text-muted">
      {{ t('desktop.settings.fileIconsFallback') }}
    </p>
  </DesktopSettingsGroup>
</template>
