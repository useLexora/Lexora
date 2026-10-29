<script setup lang="ts">
import type { SpeechProvider } from '@buddy-shared/speech/speechApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { speechEnabled } from '@buddy-shared/speech/speechApi'
import { Mic20Regular } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useSpeechCatalog } from '../useSpeechCatalog'

const props = defineProps<{ language: BuddyLocale, disabled?: boolean }>()
const emit = defineEmits<{ start: [provider: SpeechProvider] }>()
const { t } = useBuddyI18n(() => props.language)
const { catalog, selected } = useSpeechCatalog()
const unavailable = computed(() => !selected('speech.transcribe')?.supported)
const label = computed(() => t('speech.record'))

function activate() {
  const provider = selected('speech.transcribe')
  if (provider?.supported)
    emit('start', provider)
}
</script>

<template>
  <NTooltip v-if="speechEnabled(catalog.preferences, 'speech.transcribe')" placement="top">
    <template #trigger>
      <span class="inline-flex flex-none items-center">
        <NButton class="buddy-icon-button" quaternary :disabled="disabled || unavailable" :aria-label="label" data-testid="speech-record" @mousedown.prevent @click="activate">
          <template #icon>
            <DesktopIcon :component="Mic20Regular" :size="18" />
          </template>
        </NButton>
      </span>
    </template>
    {{ unavailable ? t('speech.configureInput') : label }}
  </NTooltip>
</template>
