<script setup lang="ts">
import { ArrowClockwise20Regular, ErrorCircle20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useWorkbench } from '@/workbench/browser/workbenchContext'

defineProps<{ failed: boolean }>()
defineEmits<{ retry: [] }>()
const { labels } = useWorkbench()
</script>

<template>
  <section
    class="desktop-task-loading relative flex flex-1 min-w-0 min-h-0 flex-col bg-surface select-none"
    :aria-busy="!failed"
    data-testid="task-loading"
  >
    <header class="flex flex-none items-center justify-between gap-[0.85rem] border-b-1 border-b-solid border-b-border bg-surface pt-0 pr-3 pb-0 pl-4 h-region-header">
      <div class="grid min-w-0 flex-1 text-[0.88rem] font-660 overflow-hidden text-ellipsis whitespace-nowrap">
        <slot name="title" />
      </div>
      <div class="flex min-w-0 flex-none items-center gap-[0.18rem]">
        <slot name="actions" />
      </div>
    </header>

    <div v-if="failed" class="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 p-8 text-muted text-center" role="alert">
      <div class="grid place-items-center w-11 h-11 rounded-full bg-danger-surface text-danger mb-[0.15rem]" aria-hidden="true">
        <DesktopIcon :component="ErrorCircle20Regular" :size="24" />
      </div>
      <div class="flex flex-col gap-1">
        <h3 class="m-0 text-[0.95rem] font-600 text-strong">
          {{ labels.failed }}
        </h3>
        <p class="m-0 text-[0.78rem] text-muted">
          {{ labels.commandFailed }}
        </p>
      </div>
      <NButton size="small" secondary @click="$emit('retry')">
        <template #icon>
          <DesktopIcon :component="ArrowClockwise20Regular" />
        </template>
        {{ labels.retry }}
      </NButton>
    </div>

    <div v-else class="relative flex flex-1 min-w-0 min-h-0 flex-col">
      <div class="absolute top-0 left-0 right-0 h-[2px] overflow-hidden z-2" aria-hidden="true">
        <div class="desktop-task-loading__progress-bar h-full w-[40%]" />
      </div>

      <main class="flex-1 grid place-items-center min-w-0 min-h-0 p-6">
        <div class="desktop-task-loading__status inline-flex items-center gap-2 py-[0.35rem] px-3 rounded-micro border-1 border-solid border-border bg-raised text-muted text-[0.74rem] shadow-soft" role="status">
          <span class="desktop-task-loading__spinner w-[0.8rem] h-[0.8rem] rounded-full" aria-hidden="true" />
          <span>{{ labels.loading }}</span>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped lang="scss">
.desktop-task-loading__progress-bar {
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--buddy-accent-solid) 50%,
    transparent 100%
  );
  animation: task-progress 1.4s ease-in-out infinite;
}

@keyframes task-progress {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(350%);
  }
}

.desktop-task-loading__status {
  animation: task-status-appear 220ms ease-out 180ms backwards;
}

@keyframes task-status-appear {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.desktop-task-loading__spinner {
  border: 1.5px solid var(--buddy-border-subtle);
  border-top-color: var(--buddy-accent-solid);
  animation: task-spin 800ms linear infinite;
}

@keyframes task-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-task-loading__progress-bar,
  .desktop-task-loading__status,
  .desktop-task-loading__spinner {
    animation: none !important;
  }
}
</style>
