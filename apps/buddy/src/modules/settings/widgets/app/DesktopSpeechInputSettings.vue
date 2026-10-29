<script setup lang="ts">
import type { ApplicationSettingsProps } from './typing'
import { speechEnabled, speechSelection } from '@buddy-shared/speech/speechApi'
import { Mic20Regular, Stop20Regular } from '@vicons/fluent'
import { NButton, NInput, NProgress, NSelect, NSwitch } from 'naive-ui'
import { computed, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { speechErrorKey, useMicrophoneTest, useSpeechRecorder } from '@/modules/speech'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopSpeechSourceSelect from './DesktopSpeechSourceSelect.vue'
import { useSpeechSelection } from './useSpeechSelection'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const preferences = computed(() => props.config?.desktop.speech ?? {})
const selection = computed(() => speechSelection(preferences.value, 'speech.transcribe'))
const languages = computed(() => [{ value: '', label: t('speech.automaticLanguage') }, ...[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }, { value: 'ko', label: '한국어' }, { value: 'fr', label: 'Français' }, { value: 'de', label: 'Deutsch' }, { value: 'es', label: 'Español' }]])
const enabled = computed(() => speechEnabled(preferences.value, 'speech.transcribe'))
const { selected, select, selecting, error: selectionError } = useSpeechSelection()
const { pending, failed, save } = useSettingMutation(props.updateSettings)
const { active, level, error: microphoneError, start: testMicrophone, stop: stopMicrophone } = useMicrophoneTest()
const { state, text, error, busy, start, finish, cancel } = useSpeechRecorder()
watch(() => selection.value?.id, () => cancel())
async function setLanguage(language: string) {
  const id = selection.value?.id
  const settings = Object.fromEntries(Object.entries(preferences.value.transcriptionSettings ?? {}).map(([key, { language }]) => [key, { language }]))
  if (id)
    await save('language', { desktop: { speech: { transcriptionSettings: { ...settings, [id]: { language } } } } })
}
watch(enabled, (value) => {
  if (!value) {
    stopMicrophone()
    cancel(false)
  }
})
function transcribe() {
  stopMicrophone()
  if (state.value === 'recording')
    return void finish()
  if (busy.value)
    return cancel()
  const provider = selected('speech.transcribe')
  if (enabled.value && provider?.supported)
    void start(provider)
}
</script>

<template>
  <section class="grid gap-3" data-testid="speech-input-settings">
    <div class="flex min-h-8 flex-wrap items-center justify-between gap-3">
      <h3 class="m-0 text-sm font-600">
        {{ t('speech.input') }}
      </h3>
      <div class="flex items-center gap-2">
        <NButton size="small" quaternary :disabled="!enabled || busy" @click="active ? stopMicrophone() : testMicrophone()">
          <template #icon>
            <DesktopIcon :component="active ? Stop20Regular : Mic20Regular" :size="18" />
          </template>
          {{ t(active ? 'speech.stopTest' : 'speech.testMicrophone') }}
        </NButton>
        <NButton size="small" secondary :disabled="!enabled || !selected('speech.transcribe')?.supported" :loading="state === 'loading' || state === 'finishing'" @click="transcribe">
          {{ t(state === 'recording' ? 'speech.finish' : busy ? 'speech.cancel' : 'speech.testTranscribe') }}
        </NButton>
      </div>
    </div>
    <DesktopSettingsGroup>
      <DesktopSettingRow :label="t('speech.enableInput')" toggle :error="failed.has('enabled') ? t('desktop.settings.saveFailed') : undefined">
        <template #default="{ controlAttrs }">
          <NSwitch v-bind="controlAttrs" :round="false" :value="enabled" :loading="pending.has('enabled')" :disabled="pending.has('enabled')" @update:value="save('enabled', { desktop: { speech: { inputEnabled: $event } } })" />
        </template>
      </DesktopSettingRow>
      <DesktopSettingRow :label="t('speech.inputModel')" :disabled="!enabled" :error="enabled && selectionError ? t(speechErrorKey(selectionError, 'speech.failed')) : undefined">
        <template #default="{ controlAttrs }">
          <DesktopSpeechSourceSelect v-bind="controlAttrs" kind="speech.transcribe" :language="language" :value="selected('speech.transcribe')?.id ?? null" :loading="selecting" :disabled="!enabled || selecting" @select="select('speech.transcribe', $event)" />
        </template>
      </DesktopSettingRow>
      <DesktopSettingRow v-if="selected('speech.transcribe')?.supportsLanguageSelection" :label="t('speech.recognitionLanguage')" :disabled="!enabled" :error="failed.has('language') ? t('desktop.settings.saveFailed') : undefined">
        <template #default="{ controlAttrs }">
          <NSelect v-bind="controlAttrs" :value="preferences.transcriptionSettings?.[selected('speech.transcribe')!.id]?.language ?? ''" :options="languages" filterable :disabled="!enabled || pending.has('language')" @update:value="setLanguage" />
        </template>
      </DesktopSettingRow>
    </DesktopSettingsGroup>
    <div v-if="enabled && (active || microphoneError || error || state !== 'idle')" class="grid gap-3">
      <div v-if="active" class="flex items-center gap-3">
        <NProgress type="line" :percentage="level" :show-indicator="false" class="max-w-40" :aria-label="t('speech.inputLevel')" />
        <span class="text-xs text-muted" role="status">{{ t('speech.microphoneTesting') }}</span>
      </div>
      <p v-if="microphoneError || error" role="alert" class="m-0 text-xs text-danger">
        {{ t(speechErrorKey(microphoneError || error, 'speech.failed')) }}
      </p>
      <p v-if="busy" role="status" class="m-0 text-xs text-muted">
        {{ t(state === 'recording' ? 'speech.recordingTest' : state === 'loading' ? 'speech.loading' : 'speech.finishing') }}
      </p>
      <NInput v-if="state !== 'idle'" :value="text" type="textarea" readonly :autosize="{ minRows: 2, maxRows: 4 }" :placeholder="t('speech.empty')" :input-props="{ 'aria-label': t('speech.transcript') }" />
    </div>
  </section>
</template>
