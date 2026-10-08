<script setup lang="ts">
import type { LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import type { GeneralSettingField } from '../../model/settingsRegistry'
import { NSelect, NSpin, NSwitch, useMessage } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSettingsContext } from '../../settingsContext'

const props = defineProps<{ field: GeneralSettingField }>()
const { applicationSettings: { config, language, updateSettings } } = useSettingsContext()
const { languageOptions, t } = useBuddyI18n(language)
const message = useMessage()
const pending = shallowRef(false)
const labelId = useId()
const contextPanelModes = computed(() => [
  { label: t('desktop.settings.contextPanelTask'), value: 'task' },
  { label: t('desktop.settings.contextPanelSpace'), value: 'space' },
  { label: t('desktop.settings.contextPanelIndependent'), value: 'independent' },
])
const labels = computed(() => ({
  language: { title: t('settings.language'), description: '', testId: undefined },
  contextPanelMode: { title: t('desktop.settings.contextPanelMode'), description: t('desktop.settings.contextPanelModeDescription'), testId: 'context-panel-mode-setting' },
  contextPanelGlobal: { title: t('desktop.settings.contextPanelGlobal'), description: t('desktop.settings.contextPanelGlobalDescription'), testId: 'context-panel-global-setting' },
}))
async function save(patch: LexoraConfigPatch) {
  if (pending.value)
    return
  pending.value = true
  try {
    if (!await updateSettings(patch))
      message.error(t('desktop.settings.saveFailed'))
  }
  finally { pending.value = false }
}
</script>

<template>
  <div v-if="config" class="desktop-settings-row" :data-testid="labels[props.field].testId">
    <div class="desktop-settings-row__copy">
      <strong :id="labelId">{{ labels[field].title }}</strong>
      <small v-if="labels[field].description">{{ labels[field].description }}</small>
    </div>
    <div class="desktop-settings-row__control" :class="{ 'desktop-settings-row__control--toggle': field === 'contextPanelGlobal' }">
      <NSelect v-if="field === 'language'" :aria-labelledby="labelId" :options="languageOptions" :value="config.desktop.language" :disabled="pending" @update:value="save({ desktop: { language: $event } })" />
      <NSelect v-else-if="field === 'contextPanelMode'" :aria-labelledby="labelId" :options="contextPanelModes" :value="config.desktop.contextPanelMode" :disabled="pending" @update:value="save({ desktop: { contextPanelMode: $event } })" />
      <NSwitch v-else :aria-labelledby="labelId" :aria-disabled="pending" :round="false" :value="config.desktop.contextPanelGlobal" :loading="pending" :disabled="pending" @update:value="save({ desktop: { contextPanelGlobal: $event } })" />
      <NSpin v-if="pending && field !== 'contextPanelGlobal'" size="small" />
    </div>
  </div>
</template>

<style scoped>
.desktop-settings-row { display: grid; min-height: 4rem; grid-template-columns: minmax(0, 1fr) minmax(10rem, 19rem); align-items: center; gap: 2rem; border-bottom: 1px solid var(--buddy-border-subtle); padding: 0.75rem 0.9rem; }
.desktop-settings-row:last-child { border-bottom: 0; }
.desktop-settings-row__copy { display: grid; gap: 0.25rem; }
.desktop-settings-row strong { color: var(--buddy-text-primary); font-size: 0.8rem; font-weight: 600; }
.desktop-settings-row small { color: var(--buddy-text-secondary); font-size: 0.7rem; line-height: 1.5; }
.desktop-settings-row__control { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.55rem; }
.desktop-settings-row__control--toggle { grid-template-columns: auto; justify-items: end; }
@container (max-width: 560px) { .desktop-settings-row { grid-template-columns: minmax(0, 1fr); gap: 0.7rem; } }
</style>
