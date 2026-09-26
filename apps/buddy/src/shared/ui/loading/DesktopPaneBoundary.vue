<script setup lang="ts">
import { NButton } from 'naive-ui'

withDefaults(defineProps<{
  animate?: boolean
  loading: boolean
  error?: string | null
  label: string
  retryLabel: string
}>(), { animate: true })
const emit = defineEmits<{ retry: [] }>()
defineSlots<{ default: () => unknown }>()
</script>

<template>
  <div class="desktop-pane-boundary" :class="{ 'is-animated': animate }" :aria-busy="loading">
    <div class="desktop-pane-boundary__content" :class="{ 'is-covered': loading || error }" :inert="loading || !!error" :aria-hidden="loading || !!error">
      <slot />
    </div>
    <Transition name="pane-reveal" :css="animate">
      <div v-if="loading || error" class="desktop-pane-boundary__cover" :role="error ? 'alert' : 'status'">
        <div class="desktop-pane-boundary__status">
          <span v-if="!error" class="desktop-pane-boundary__spinner" aria-hidden="true" />
          <span>{{ error || label }}</span>
          <NButton v-if="error" size="small" secondary @click="emit('retry')">
            {{ retryLabel }}
          </NButton>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.desktop-pane-boundary,
.desktop-pane-boundary__content {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
.desktop-pane-boundary { position: relative; isolation: isolate; }
.is-animated > .desktop-pane-boundary__content { transition: opacity 160ms ease; }
.desktop-pane-boundary__content.is-covered { opacity: 0; pointer-events: none; }
.desktop-pane-boundary__cover {
  position: absolute;
  z-index: 3;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--buddy-surface-base);
}
.desktop-pane-boundary__status {
  display: flex;
  max-width: 24rem;
  flex-direction: column;
  align-items: center;
  gap: 0.9rem;
  padding: 1.5rem;
  color: var(--buddy-text-secondary);
  font-size: 0.75rem;
  line-height: 1.6;
  text-align: center;
}
.desktop-pane-boundary__spinner {
  width: 1.1rem;
  height: 1.1rem;
  border: 1.5px solid var(--buddy-border-subtle);
  border-top-color: var(--buddy-text-muted);
  border-radius: 50%;
  animation: pane-spin 900ms linear infinite;
}
.pane-reveal-enter-active, .pane-reveal-leave-active { transition: opacity 160ms ease; }
.pane-reveal-enter-from, .pane-reveal-leave-to { opacity: 0; }
@keyframes pane-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .desktop-pane-boundary__spinner { animation: none; }
  .is-animated > .desktop-pane-boundary__content, .pane-reveal-enter-active, .pane-reveal-leave-active { transition: none; }
}
</style>
