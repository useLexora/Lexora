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
  <div class="desktop-pane-boundary relative isolate" :class="{ 'is-animated': animate }" :aria-busy="loading">
    <div class="desktop-pane-boundary__content" :class="{ 'is-covered': loading || error }" :inert="loading || !!error" :aria-hidden="loading || !!error">
      <slot />
    </div>
    <Transition name="pane-reveal" :css="animate">
      <div v-if="loading || error" class="absolute z-3 inset-0 grid place-items-center bg-surface" :role="error ? 'alert' : 'status'">
        <div class="flex max-w-96 flex-col items-center gap-[0.9rem] p-6 text-muted text-[0.75rem] leading-[1.6] text-center">
          <span v-if="!error" class="desktop-pane-boundary__spinner w-[1.1rem] h-[1.1rem] rounded-full" aria-hidden="true" />
          <span>{{ error || label }}</span>
          <NButton v-if="error" size="small" secondary @click="emit('retry')">
            {{ retryLabel }}
          </NButton>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
.desktop-pane-boundary,
.desktop-pane-boundary__content {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
.is-animated > .desktop-pane-boundary__content { transition: opacity 160ms ease; }
.desktop-pane-boundary__content.is-covered { opacity: 0; pointer-events: none; }

.desktop-pane-boundary__spinner {
  border: 1.5px solid var(--buddy-border-subtle);
  border-top-color: var(--buddy-text-muted);
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
