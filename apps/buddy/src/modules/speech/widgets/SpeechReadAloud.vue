<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { speechEnabled, speechOutput } from '@buddy-shared/speech/speechApi'
import { NButton, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { speechErrorKey } from '../speechError'
import { speechText } from '../speechText'
import { useSpeechCatalog } from '../useSpeechCatalog'
import { useSpeechReadAloud } from '../useSpeechReadAloud'
import { useSystemVoices } from '../useSystemVoices'

const props = defineProps<{ language: BuddyLocale, text: string, owner: string }>()
const { t } = useBuddyI18n(() => props.language)
const { busy, error, play, stop } = useSpeechReadAloud({ owner: () => props.owner, text: () => props.text, language: () => props.language })
const { catalog, selected } = useSpeechCatalog()
const { voices } = useSystemVoices()
const unavailable = computed(() => {
  if (!speechText(props.text))
    return 'speech.textEmpty'
  if (speechOutput(catalog.value.preferences) === 'system')
    return voices.value.length ? undefined : 'speech.noSystemVoice'
  return selected('speech.synthesize')?.supported ? undefined : 'speech.configureOutput'
})
const disabled = computed(() => !busy.value && !!unavailable.value)
const tooltip = computed(() => t(busy.value ? 'speech.stop' : unavailable.value ?? (error.value ? speechErrorKey(error.value, 'speech.playbackFailed') : 'speech.read')))
const icon = computed(() => busy.value ? 'messagePlaybackStop' : disabled.value || error.value ? 'messageReadAloudUnavailable' : 'messageReadAloud')
</script>

<template>
  <NTooltip v-if="speechEnabled(catalog.preferences, 'speech.synthesize')" placement="bottom">
    <template #trigger>
      <span class="inline-flex items-center" :data-speech-owner="owner" :data-speech-playing="busy">
        <NButton quaternary size="tiny" class="buddy-icon-button" :aria-label="t(busy ? 'speech.stop' : 'speech.read')" :data-testid="`speech-read-${owner}`" :disabled="disabled" @click="busy ? stop() : play()">
          <template #icon>
            <DesktopIcon :name="icon" />
          </template>
        </NButton>
      </span>
    </template>
    {{ tooltip }}
  </NTooltip>
</template>
