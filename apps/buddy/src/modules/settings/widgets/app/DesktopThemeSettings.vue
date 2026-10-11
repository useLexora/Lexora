<script setup lang="ts">
import type { SelectGroupOption, SelectOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NSelect, useMessage } from 'naive-ui'
import { computed, h, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { useDesktopTheme } from '@/theme/useDesktopTheme'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

const props = defineProps<{ language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const { snapshot } = useDesktopTheme()
const message = useMessage()
const pending = shallowRef(false)
const options = computed<Array<SelectGroupOption | SelectOption>>(() => {
  const groups = (['light', 'dark'] as const).map(appearance => ({
    type: 'group',
    key: appearance,
    label: t(appearance === 'light' ? 'desktop.settings.themeLight' : 'desktop.settings.themeDark'),
    children: snapshot.value.themes.filter(theme => theme.appearance === appearance).map(theme => ({
      label: theme.label,
      value: theme.id,
      source: theme.packageName || t('desktop.settings.themeUser'),
      swatch: theme.swatch,
    })),
  } satisfies SelectGroupOption)).filter(group => group.children.length)
  const selected = snapshot.value.preference.id
  const themes: Array<SelectGroupOption | SelectOption> = [{ label: t('desktop.settings.themeSystem'), value: 'system' }, ...groups]
  if (selected !== 'system' && !snapshot.value.themes.some(theme => theme.id === selected))
    themes.unshift({ label: selected, value: selected, disabled: true, source: t('desktop.settings.themeUnavailable') })
  return themes
})
function renderLabel(option: SelectOption | SelectGroupOption) {
  if (option.type === 'group' || option.value === 'system')
    return String(option.label)
  return h('span', { class: 'flex min-w-0 items-center gap-2' }, [
    h('span', { class: 'size-3 shrink-0 rounded-full border border-solid border-border', style: { backgroundColor: String(option.swatch ?? 'transparent') } }),
    h('span', { class: 'truncate' }, String(option.label)),
    h('small', { class: 'ml-auto truncate text-muted' }, String(option.source ?? '')),
  ])
}
async function update(id: string) {
  pending.value = true
  try {
    await requireDesktopApi().themes.request({ action: 'preference', preference: { id } })
  }
  catch { message.error(t('desktop.settings.saveFailed')) }
  finally { pending.value = false }
}
</script>

<template>
  <DesktopSettingsGroup>
    <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.theme')">
      <NSelect v-bind="controlAttrs" filterable :options="options" :value="snapshot.preference.id" :render-label="renderLabel" :disabled="pending" @update:value="update" />
    </DesktopSettingRow>
    <p v-if="snapshot.unavailable" class="m-0 text-xs text-muted">
      {{ t('desktop.settings.themeFallback') }}
    </p>
  </DesktopSettingsGroup>
</template>
