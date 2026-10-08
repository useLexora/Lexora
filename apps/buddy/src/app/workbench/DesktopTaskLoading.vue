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
    class="desktop-task-loading"
    :aria-busy="!failed"
    data-testid="task-loading"
  >
    <header class="desktop-task-loading__header">
      <div class="desktop-task-loading__copy">
        <slot name="title" />
      </div>
      <div class="desktop-task-loading__actions">
        <slot name="actions" />
      </div>
    </header>

    <div v-if="failed" class="desktop-task-loading__failure" role="alert">
      <div class="desktop-task-loading__failure-icon-wrap" aria-hidden="true">
        <DesktopIcon :component="ErrorCircle20Regular" :size="24" />
      </div>
      <div class="desktop-task-loading__failure-copy">
        <h3 class="desktop-task-loading__failure-title">
          {{ labels.failed }}
        </h3>
        <p class="desktop-task-loading__failure-desc">
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

    <div v-else class="desktop-task-loading__body">
      <div class="desktop-task-loading__progress" aria-hidden="true">
        <div class="desktop-task-loading__progress-bar" />
      </div>

      <main class="desktop-task-loading__content">
        <div class="desktop-task-loading__status" role="status">
          <span class="desktop-task-loading__spinner" aria-hidden="true" />
          <span>{{ labels.loading }}</span>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped lang="scss">
.desktop-task-loading {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--buddy-surface-base);
  user-select: none;
}

.desktop-task-loading__header {
  display: flex;
  height: var(--buddy-region-header-height);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.85rem;
  border-bottom: 1px solid var(--buddy-border-subtle);
  background: var(--buddy-surface-base);
  padding: 0 0.75rem 0 1rem;
}

.desktop-task-loading__copy {
  display: grid;
  min-width: 0;
  flex: 1;
  font-size: 0.88rem;
  font-weight: 660;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-task-loading__actions {
  display: flex;
  min-width: 0;
  flex: none;
  align-items: center;
  gap: 0.18rem;
}

.desktop-task-loading__body {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.desktop-task-loading__progress {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  overflow: hidden;
  z-index: 2;
}

.desktop-task-loading__progress-bar {
  height: 100%;
  width: 40%;
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

.desktop-task-loading__content {
  flex: 1;
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
  padding: 1.5rem;
}

.desktop-task-loading__status {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.75rem;
  border-radius: var(--buddy-radius-micro);
  border: 1px solid var(--buddy-border-subtle);
  background: var(--buddy-surface-raised);
  color: var(--buddy-text-secondary);
  font-size: 0.74rem;
  box-shadow: var(--buddy-shadow-soft);
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
  width: 0.8rem;
  height: 0.8rem;
  border: 1.5px solid var(--buddy-border-subtle);
  border-top-color: var(--buddy-accent-solid);
  border-radius: 50%;
  animation: task-spin 800ms linear infinite;
}

@keyframes task-spin {
  to {
    transform: rotate(360deg);
  }
}

.desktop-task-loading__failure {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 2rem;
  color: var(--buddy-text-secondary);
  text-align: center;
}

.desktop-task-loading__failure-icon-wrap {
  display: grid;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  background: var(--buddy-status-danger-surface);
  color: var(--buddy-status-danger-text);
  margin-bottom: 0.15rem;
}

.desktop-task-loading__failure-copy {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.desktop-task-loading__failure-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--buddy-text-strong);
}

.desktop-task-loading__failure-desc {
  margin: 0;
  font-size: 0.78rem;
  color: var(--buddy-text-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .desktop-task-loading__progress-bar,
  .desktop-task-loading__status,
  .desktop-task-loading__spinner {
    animation: none !important;
  }
}
</style>
