<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { speechEnabled, speechOutput } from '@buddy-shared/speech/speechApi'
import { NButton, NTooltip } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { speechErrorKey } from '../speechError'
import { speechText } from '../speechText'
import { useSpeechCatalog } from '../useSpeechCatalog'
import { useSpeechReadAloud } from '../useSpeechReadAloud'

const props = defineProps<{ language: BuddyLocale, text: string, owner: string }>()
const { t } = useBuddyI18n(() => props.language)
const { busy, phase, error, play, stop } = useSpeechReadAloud({ owner: () => props.owner, text: () => props.text, language: () => props.language })
const { catalog, loaded, selected } = useSpeechCatalog()
const focused = shallowRef(false)
const unavailable = computed(() => {
  if (!speechText(props.text))
    return 'speech.textEmpty'
  if (speechOutput(catalog.value.preferences) === 'system')
    return undefined
  return selected('speech.synthesize')?.supported ? undefined : 'speech.configureOutput'
})
const disabled = computed(() => !busy.value && !!unavailable.value)
const preparing = computed(() => busy.value && phase.value !== 'playing')
const tooltip = computed(() => {
  switch (phase.value) {
    case 'preparing': return t('speech.playbackPreparing')
    case 'generating': return t('speech.playbackGenerating')
    case 'loading': return t('speech.playbackLoading')
    case 'playing': return t('speech.playing')
    default: return t(unavailable.value ?? (error.value ? speechErrorKey(error.value, 'speech.playbackFailed') : 'speech.read'))
  }
})
</script>

<template>
  <NTooltip v-if="loaded && speechEnabled(catalog.preferences, 'speech.synthesize')" placement="bottom" :show="focused ? true : undefined">
    <template #trigger>
      <span class="speech-read-aloud inline-flex items-center" :data-speech-owner="owner" :data-speech-playing="busy" :data-speech-phase="phase" @focusin="focused = true" @focusout="focused = false">
        <NButton quaternary size="tiny" class="buddy-icon-button" :aria-label="tooltip" :data-testid="`speech-read-${owner}`" :disabled="disabled" @click="busy ? stop() : play()">
          <template #icon>
            <DesktopIcon v-if="disabled" name="messageReadAloudUnavailable" />
            <DesktopIcon v-else>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" :class="{ 'text-accent-text': busy }" aria-hidden="true">
                <path d="m11.5 5.5-4 3.5H5a.5.5 0 0 0-.5.5v5a.5.5 0 0 0 .5.5h2.5l4 3.5z" />
                <g v-if="preparing" class="speech-read-aloud__spinner">
                  <circle cx="18" cy="12" r="3" opacity="0.25" />
                  <path d="M18 9a3 3 0 0 1 3 3" />
                </g>
                <g v-else :class="{ 'speech-read-aloud__waves': phase === 'playing' }">
                  <path d="M15 8.5a5 5 0 0 1 0 7" />
                  <path d="M17.5 6a8.5 8.5 0 0 1 0 12" />
                </g>
              </svg>
            </DesktopIcon>
          </template>
        </NButton>
      </span>
    </template>
    {{ tooltip }}
  </NTooltip>
</template>

<style scoped lang="scss">
.speech-read-aloud__spinner {
  transform-origin: 18px 12px;
  animation: speech-read-aloud-spin 900ms linear infinite;
}

.speech-read-aloud__waves path {
  animation: speech-read-aloud-pulse 1200ms ease-in-out infinite;

  &:last-child {
    animation-delay: 180ms;
  }
}

@keyframes speech-read-aloud-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes speech-read-aloud-pulse {
  0%, 100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .speech-read-aloud__spinner,
  .speech-read-aloud__waves path {
    animation: none;
  }
}
</style>
