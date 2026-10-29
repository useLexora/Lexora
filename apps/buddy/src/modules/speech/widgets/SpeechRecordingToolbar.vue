<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Checkmark20Regular, Dismiss20Regular } from '@vicons/fluent'
import { useElementSize } from '@vueuse/core'
import { NButton, NTooltip } from 'naive-ui'
import { computed, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ language: BuddyLocale, state: string, levels: readonly number[], elapsedMs: number }>()
const emit = defineEmits<{ cancel: [], finish: [] }>()
const { t } = useBuddyI18n(() => props.language)
const waveform = useTemplateRef<HTMLElement>('waveform')
const { width } = useElementSize(waveform)
const bars = computed(() => {
  const count = Math.max(1, Math.floor((width.value + 3) / 6))
  const samples = props.levels.slice(-count)
  return [...Array.from<number>({ length: Math.max(0, count - samples.length) }).fill(0), ...samples]
})
const duration = computed(() => {
  const seconds = Math.floor(props.elapsedMs / 1000)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
})
const status = computed(() => t(props.state === 'loading' ? 'speech.loading' : props.state === 'recording' ? 'speech.recording' : 'speech.finishing'))
</script>

<template>
  <div class="flex min-w-0 w-full items-center gap-2 rounded-micro bg-accent-subtle text-accent-on-surface px-1" data-testid="speech-recording-toolbar" :data-state="state">
    <NTooltip placement="top">
      <template #trigger>
        <NButton quaternary class="buddy-icon-button flex-none" :aria-label="t('speech.cancel')" data-testid="speech-cancel" @click="emit('cancel')">
          <template #icon>
            <DesktopIcon :component="Dismiss20Regular" :size="18" />
          </template>
        </NButton>
      </template>
      {{ t('speech.cancel') }} · Esc
    </NTooltip>
    <span role="status" class="min-w-0 truncate text-xs">{{ status }}</span>
    <span v-if="state !== 'loading'" class="flex-none text-xs font-mono tabular-nums" data-testid="speech-recording-time">{{ duration }}</span>
    <div ref="waveform" class="flex h-8 min-w-4 flex-1 items-center gap-[3px] overflow-hidden" aria-hidden="true" data-testid="speech-waveform">
      <span v-for="(level, index) in bars" :key="index" class="w-[3px] flex-none rounded-full bg-accent" :style="{ height: `${3 + level * 23}px`, opacity: level > 0.01 ? 1 : 0.3 }" />
    </div>
    <NTooltip placement="top">
      <template #trigger>
        <NButton type="primary" class="buddy-icon-button flex-none" :loading="state !== 'recording'" :disabled="state !== 'recording'" :aria-label="t('speech.finish')" data-testid="speech-finish" @click="emit('finish')">
          <template #icon>
            <DesktopIcon :component="Checkmark20Regular" :size="18" />
          </template>
        </NButton>
      </template>
      {{ t('speech.finish') }}
    </NTooltip>
  </div>
</template>
