<script setup lang="ts">
import type { SpeechProvider } from '@buddy-shared/speech/speechApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NSelect } from 'naive-ui'
import { onScopeDispose, shallowRef, useAttrs, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { speechErrorKey } from '@/modules/speech'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ provider: SpeechProvider, value: string, disabled: boolean, language: BuddyLocale }>()
const emit = defineEmits<{ select: [value: string] }>()
const attrs = useAttrs()
const { t } = useBuddyI18n(() => props.language)
const options = shallowRef<{ value: string, label: string }[]>([])
const loading = shallowRef(false)
const error = shallowRef('')
let epoch = 0
async function load() {
  const current = ++epoch
  loading.value = true
  error.value = ''
  options.value = []
  try {
    const voices = await requireDesktopApi().speech.voices({ id: props.provider.id, revision: props.provider.revision, kind: props.provider.kind })
    if (current === epoch)
      options.value = voices.map(voice => ({ value: voice.id, label: voice.name }))
  }
  catch (cause) {
    if (current === epoch)
      error.value = cause instanceof Error ? cause.message : 'SPEECH_FAILED'
  }
  finally {
    if (current === epoch)
      loading.value = false
  }
}
watch([() => props.provider.id, () => props.provider.revision], load, { immediate: true })
onScopeDispose(() => {
  epoch++
})
</script>

<template>
  <NSelect v-bind="attrs" :value="value || null" :options="options" filterable tag :disabled="disabled" :loading="loading" :placeholder="t('speech.chooseVoice')" @update:value="emit('select', $event)" />
  <div v-if="error" class="flex items-start justify-between gap-2">
    <span class="text-xs text-danger" role="alert">{{ t(speechErrorKey(error, 'speech.voicesLoadFailed')) }}</span>
    <NButton text size="tiny" :disabled="disabled || loading" @click="load">
      {{ t('speech.retry') }}
    </NButton>
  </div>
</template>
