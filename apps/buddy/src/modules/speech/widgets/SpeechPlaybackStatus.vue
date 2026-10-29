<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Stop20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { activeSpeechPlayback } from '../speechPlaybackState'
import { useSpeechScopeKey } from '../speechScope'

const props = defineProps<{ language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const scope = useSpeechScopeKey()
const current = computed(() => scope.value !== null && activeSpeechPlayback.value?.scope === scope.value ? activeSpeechPlayback.value : null)
</script>

<template>
  <div v-if="current" class="flex items-center justify-between gap-2 text-xs text-muted mb-2" data-testid="speech-playback-status">
    <span role="status">{{ t(current.phase === 'preparing' ? 'speech.playbackPreparing' : 'speech.playing') }}</span>
    <NButton size="tiny" quaternary :aria-label="t('speech.stop')" @click="current.stop">
      <template #icon>
        <DesktopIcon :component="Stop20Regular" :size="16" />
      </template>
      {{ t('speech.stop') }}
    </NButton>
  </div>
</template>
