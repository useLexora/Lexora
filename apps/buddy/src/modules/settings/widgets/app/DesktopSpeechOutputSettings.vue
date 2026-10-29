<script setup lang="ts">
import type { SpeechSource } from '@buddy-shared/speech/speechApi'
import type { ApplicationSettingsProps } from './typing'
import { speechEnabled, speechSelection, speechSource } from '@buddy-shared/speech/speechApi'
import { NButton, NSelect, NSlider, NSwitch } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { speechErrorKey, useSpeechReadAloud, useSystemVoices } from '@/modules/speech'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopSpeechSourceSelect from './DesktopSpeechSourceSelect.vue'
import DesktopSpeechVoiceSelect from './DesktopSpeechVoiceSelect.vue'
import { useSpeechSelection } from './useSpeechSelection'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const preferences = computed(() => props.config?.desktop.speech ?? {})
const enabled = computed(() => speechEnabled(preferences.value, 'speech.synthesize'))
const source = computed(() => speechSource(preferences.value, 'speech.synthesize'))
const system = computed(() => source.value === 'system')
const sources = computed(() => [{ value: 'system' as const, label: t('speech.systemSource') }, { value: 'model' as const, label: t('speech.modelServices') }])
const { selected, select, selecting, error } = useSpeechSelection()
const { voices } = useSystemVoices()
const { pending, failed, save } = useSettingMutation(props.updateSettings)
const voiceOptions = computed(() => [{ value: '', label: t('speech.defaultVoice') }, ...voices.value.map(voice => ({ value: voice.voiceURI, label: `${voice.name} · ${voice.lang}` }))])
const canSelectVoice = computed(() => !system.value && selected('speech.synthesize')?.supportsVoiceSelection)
const selection = computed(() => speechSelection(preferences.value, 'speech.synthesize'))
const voiceSettings = computed(() => selection.value ? preferences.value.voiceSettings?.[selection.value.id] : undefined)
const rate = computed(() => system.value ? preferences.value.systemRate ?? 1 : voiceSettings.value?.rate ?? 1)
async function setVoiceSettings(value: { voice?: string, rate?: number }) {
  const id = selection.value?.id
  const settings = Object.fromEntries(Object.entries(preferences.value.voiceSettings ?? {}).map(([key, { voice, rate }]) => [key, { voice, rate }]))
  if (id)
    await save(value.voice !== undefined ? 'voice' : 'rate', { desktop: { speech: { voiceSettings: { ...settings, [id]: { voice: voiceSettings.value?.voice ?? '', rate: voiceSettings.value?.rate ?? 1, ...value } } } } })
}
const rateRange = computed(() => system.value ? { min: 0.5, max: 2 } : selected('speech.synthesize')?.rateRange ?? { min: 0.5, max: 2 })
const rateDraft = shallowRef<number>()
const { busy, error: playbackError, play, stop, reset } = useSpeechReadAloud({ owner: () => 'settings-preview', text: () => t('speech.sample'), language: () => props.language, preferences: () => preferences.value })
const canPlay = computed(() => enabled.value && (system.value ? voices.value.length > 0 : !!selected('speech.synthesize')?.supported && (!canSelectVoice.value || !!voiceSettings.value?.voice.trim())))
watch([enabled, source, () => selection.value?.id, () => voiceSettings.value?.voice, rate, () => preferences.value.systemVoice], reset)
async function selectSource(value: SpeechSource) {
  stop()
  error.value = ''
  await save('output', { desktop: { speech: { output: value } } })
}
async function setRate(value: number) {
  if (system.value)
    await save('rate', { desktop: { speech: { systemRate: value } } })
  else
    await setVoiceSettings({ rate: value })
  rateDraft.value = undefined
}
</script>

<template>
  <section class="grid gap-3" data-testid="speech-output-settings">
    <div class="flex min-h-8 items-center justify-between gap-3">
      <h3 class="m-0 text-sm font-600">
        {{ t('speech.output') }}
      </h3>
      <NButton size="small" secondary :disabled="!canPlay && !busy" @click="busy ? stop() : play()">
        <template #icon>
          <DesktopIcon :name="busy ? 'messagePlaybackStop' : 'messageReadAloud'" :size="18" />
        </template>
        {{ t(busy ? 'speech.stop' : 'speech.preview') }}
      </NButton>
    </div>
    <DesktopSettingsGroup>
      <DesktopSettingRow :label="t('speech.enableOutput')" toggle :error="failed.has('enabled') ? t('desktop.settings.saveFailed') : undefined">
        <template #default="{ controlAttrs }">
          <NSwitch v-bind="controlAttrs" :round="false" :value="enabled" :loading="pending.has('enabled')" :disabled="pending.has('enabled')" @update:value="save('enabled', { desktop: { speech: { outputEnabled: $event } } })" />
        </template>
      </DesktopSettingRow>
      <DesktopSettingRow :label="t('speech.playbackService')" :disabled="!enabled" :error="enabled && (error || failed.has('output')) ? t(error ? speechErrorKey(error, 'speech.playbackFailed') : 'desktop.settings.saveFailed') : undefined">
        <template #default="{ controlAttrs }">
          <DesktopSegmentedControl v-bind="controlAttrs" class="justify-self-end" :model-value="source" :options="sources" :disabled="!enabled || selecting || pending.has('output')" @update:model-value="selectSource" />
        </template>
      </DesktopSettingRow>
      <DesktopSettingRow v-if="source === 'model'" :label="t('speech.outputModel')" :disabled="!enabled">
        <template #default="{ controlAttrs }">
          <DesktopSpeechSourceSelect v-bind="controlAttrs" kind="speech.synthesize" :language="language" :value="selected('speech.synthesize')?.id ?? null" :loading="selecting" :disabled="!enabled || selecting" @select="select('speech.synthesize', $event)" />
        </template>
      </DesktopSettingRow>
      <template v-if="system">
        <DesktopSettingRow :label="t('speech.voice')" :disabled="!enabled" :error="failed.has('voice') ? t('desktop.settings.saveFailed') : undefined">
          <template #default="{ controlAttrs }">
            <NSelect v-bind="controlAttrs" :value="voices.length ? preferences.systemVoice ?? '' : null" :options="voiceOptions" :disabled="!enabled || !voices.length || pending.has('voice')" :placeholder="t('speech.noSystemVoice')" @update:value="save('voice', { desktop: { speech: { systemVoice: $event } } })" />
          </template>
          <template v-if="!voices.length" #hint>
            <span class="text-xs" :class="enabled ? 'text-muted' : 'text-disabled'">{{ t('speech.systemUnavailable') }}</span>
          </template>
        </DesktopSettingRow>
      </template>
      <DesktopSettingRow v-if="canSelectVoice" :label="t('speech.voice')" :disabled="!enabled" :error="failed.has('voice') ? t('desktop.settings.saveFailed') : undefined">
        <template #default="{ controlAttrs }">
          <DesktopSpeechVoiceSelect v-if="selected('speech.synthesize')" v-bind="controlAttrs" :provider="selected('speech.synthesize')!" :language="language" :value="voiceSettings?.voice ?? ''" :disabled="!enabled || pending.has('voice')" @select="setVoiceSettings({ voice: $event })" />
        </template>
      </DesktopSettingRow>
      <template v-if="system || (canSelectVoice && selected('speech.synthesize')?.supportsRate !== false)">
        <DesktopSettingRow :label="t('speech.rate')" :disabled="!enabled" :error="failed.has('rate') ? t('desktop.settings.saveFailed') : undefined">
          <template #default="{ controlAttrs }">
            <div class="flex items-center gap-4">
              <NSlider v-bind="controlAttrs" :value="rateDraft ?? rate" :min="rateRange.min" :max="rateRange.max" :step="0.1" :disabled="!enabled || pending.has('rate')" :format-tooltip="value => `${value.toFixed(1)}×`" @update:value="rateDraft = $event" @dragend="setRate(rateDraft ?? rate)" @keyup="rateDraft !== undefined && setRate(rateDraft)" />
              <span class="text-xs tabular-nums" :class="enabled ? 'text-muted' : 'text-disabled'">{{ (rateDraft ?? rate).toFixed(1) }}×</span>
            </div>
          </template>
        </DesktopSettingRow>
      </template>
    </DesktopSettingsGroup>
    <p v-if="enabled && playbackError" class="m-0 text-xs text-danger" role="alert">
      {{ t(speechErrorKey(playbackError, 'speech.playbackFailed')) }}
    </p>
  </section>
</template>
