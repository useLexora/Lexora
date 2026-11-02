<script setup lang="ts">
import type { ApplicationStartupState } from '@buddy-shared/diagnostics/applicationStartup'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton } from 'naive-ui'
import { computed, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopStartupArtwork from './DesktopStartupArtwork.vue'
import { startupPresentation } from './startupPresentation'

const props = defineProps<{ failed: boolean, language: BuddyLocale, stages: ApplicationStartupState['stages'] }>()
const emit = defineEmits<{ retry: [], openLogs: [], openStorage: [] }>()
const { t } = useBuddyI18n(() => props.language)
const stageLabelId = useId()
const isFailed = computed(() => props.failed || props.stages.some(stage => stage.status === 'failed'))
const presentation = computed(() => startupPresentation(props.stages, isFailed.value))
</script>

<template>
  <div class="desktop-startup [--startup-avatar-size:clamp(10rem,26vmin,15rem)] absolute z-20 inset-0 overflow-hidden bg-surface select-none" :class="{ 'is-failed': isFailed }" :role="isFailed ? 'alert' : 'status'" :aria-busy="!isFailed">
    <DesktopStartupArtwork :still="isFailed" />
    <div class="desktop-startup__identity absolute top-[calc(50%_+_var(--startup-avatar-size)_/_2_+_1rem)] left-[50%] grid w-[min(28rem,_calc(100%_-_3rem))] gap-[0.85rem] justify-items-center font-brand text-center -translate-x-1/2">
      <h1 class="m-0 text-fg text-[1.25rem] font-500 tracking-[0.09em]">
        Lexora Buddy
      </h1>
      <p :id="stageLabelId" class="m-0 text-muted text-[0.75rem]">
        {{ t(presentation.label) }}
      </p>
      <div
        v-if="!isFailed"
        class="desktop-startup__progress w-40 h-[3px] overflow-hidden rounded-full bg-border"
        :class="{ 'is-indeterminate': presentation.progress === null }"
        role="progressbar"
        :aria-labelledby="stageLabelId"
        :aria-valuenow="presentation.progress === null ? undefined : Math.round(presentation.progress * 100)"
        :aria-valuemin="0"
        :aria-valuemax="100"
      >
        <div class="desktop-startup__progress-fill h-full rounded-full bg-accent" :style="presentation.progress === null ? undefined : { transform: `scaleX(${presentation.progress})` }" />
      </div>
      <div v-if="isFailed" class="flex flex-wrap justify-center gap-2 mt-[0.4rem]">
        <NButton size="small" secondary @click="emit('retry')">
          {{ t('desktop.loading.retry') }}
        </NButton>
        <NButton size="small" secondary @click="emit('openStorage')">
          {{ t('desktop.loading.openStorage') }}
        </NButton>
        <NButton size="small" quaternary @click="emit('openLogs')">
          {{ t('applicationLogs.open') }}
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-startup__progress-fill {
  transform-origin: left;
  transition: transform 180ms ease-out;
}

.desktop-startup__progress.is-indeterminate .desktop-startup__progress-fill {
  width: 35%;
  animation: startup-progress 1.6s ease-in-out infinite;
}

@keyframes startup-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(286%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-startup__progress-fill {
    transition: none;
  }

  .desktop-startup__progress.is-indeterminate .desktop-startup__progress-fill {
    animation: none;
    transform: translateX(93%);
  }
}
</style>
