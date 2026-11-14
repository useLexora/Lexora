<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Add24Regular, ArrowClockwise24Regular, ArrowCounterclockwise24Regular, ArrowDownload24Regular, ChevronLeft24Regular, ChevronRight24Regular, Copy24Regular, Dismiss24Regular, FullScreenMaximize24Regular, Subtract24Regular, TextQuote20Regular } from '@vicons/fluent'
import { NButton, NSpin, NTooltip } from 'naive-ui'
import { computed, shallowRef, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useImagePreviewActions } from './useImagePreviewActions'
import { useImageViewer } from './useImageViewer'

const props = defineProps<{
  language: BuddyLocale
  sources: readonly string[]
  names?: readonly string[]
  referenceImage?: (index: number) => Promise<boolean>
  referenced?: boolean
}>()
const emit = defineEmits<{ close: [] }>()
const current = defineModel<number>('current', { required: true })
const { t } = useBuddyI18n(() => props.language)
const root = useTemplateRef<HTMLElement>('root')
const stage = useTemplateRef<HTMLElement>('stage')
const index = computed(() => Math.max(0, Math.min(current.value, props.sources.length - 1)))
const source = computed(() => props.sources[index.value] ?? '')
const name = computed(() => props.names?.[index.value] || 'image.png')
const { ready, failed, ratio, dimensions, fit, originalSize, toggleSize, zoomIn, zoomOut, rotateLeft, rotateRight } = useImageViewer(stage, () => source.value, () => name.value)
const { busy, feedback, copy, save } = useImagePreviewActions(() => source.value, () => name.value)
const referencing = shallowRef(false)
const referencedSources = shallowRef<ReadonlySet<string>>(new Set())
const alreadyReferenced = computed(() => props.referenced || referencedSources.value.has(source.value))

async function referenceImage() {
  if (!props.referenceImage || referencing.value || alreadyReferenced.value)
    return
  const src = source.value
  referencing.value = true
  feedback.value = null
  try {
    if (!await props.referenceImage(index.value))
      throw new Error('Image reference is unavailable')
    referencedSources.value = new Set([...referencedSources.value, src])
    if (source.value === src)
      feedback.value = 'desktop.imagePreview.referenced'
  }
  catch {
    if (source.value === src)
      feedback.value = 'desktop.imagePreview.referenceFailed'
  }
  finally {
    referencing.value = false
  }
}
const transformControls = [
  { key: 'desktop.imagePreview.fit', icon: FullScreenMaximize24Regular, action: fit },
  { key: 'desktop.imagePreview.rotateLeft', icon: ArrowCounterclockwise24Regular, action: rotateLeft },
  { key: 'desktop.imagePreview.rotateRight', icon: ArrowClockwise24Regular, action: rotateRight },
] as const
const buttonTheme = {
  textColor: 'var(--buddy-media-overlay-text)',
  colorQuaternaryHover: 'var(--buddy-media-overlay-hover)',
  colorQuaternaryPressed: 'var(--buddy-media-overlay-hover)',
}
const navigationTheme = {
  ...buttonTheme,
  heightMedium: '44px',
  colorQuaternary: 'var(--buddy-media-overlay-background)',
  colorQuaternaryHover: 'color-mix(in srgb, var(--buddy-media-overlay-background) 88%, var(--buddy-media-overlay-text))',
  colorQuaternaryPressed: 'color-mix(in srgb, var(--buddy-media-overlay-background) 82%, var(--buddy-media-overlay-text))',
}

function navigate(delta: number) {
  current.value = Math.max(0, Math.min(index.value + delta, props.sources.length - 1))
  root.value?.focus({ preventScroll: true })
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
    event.preventDefault()
    if (ready.value)
      void copy()
  }
  else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    const action = {
      'ArrowLeft': () => navigate(-1),
      'ArrowRight': () => navigate(1),
      '+': zoomIn,
      '=': zoomIn,
      '-': zoomOut,
      '0': fit,
    }[event.key]
    if (action) {
      event.preventDefault()
      action()
    }
  }
}
</script>

<template>
  <div
    ref="root"
    class="buddy-image-viewer grid w-screen h-screen box-border grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden outline-none"
    role="dialog" aria-modal="true" :aria-label="t('desktop.imagePreview.title')" tabindex="-1"
    @keydown.stop="onKeydown"
  >
    <header class="flex min-w-0 items-center justify-between gap-4 px-5 py-3">
      <div class="flex min-w-0 items-center gap-3">
        <span class="truncate text-sm">{{ name }}</span>
        <span class="shrink-0 text-xs opacity-60" data-testid="image-preview-counter">{{ index + 1 }} / {{ sources.length }}</span>
        <span v-if="ready" class="hidden sm:inline shrink-0 text-xs opacity-50">{{ dimensions.width }} × {{ dimensions.height }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <NButton v-if="props.referenceImage || referenced" quaternary :theme-overrides="buttonTheme" :disabled="!ready || alreadyReferenced || referencing" :loading="referencing" @click="referenceImage">
          <template #icon>
            <DesktopIcon :component="TextQuote20Regular" />
          </template>
          {{ t(alreadyReferenced ? 'desktop.imagePreview.referenced' : 'desktop.imagePreview.reference') }}
        </NButton>
        <NButton quaternary :theme-overrides="buttonTheme" :disabled="!ready || busy" @click="copy">
          <template #icon>
            <DesktopIcon :component="Copy24Regular" />
          </template>
          {{ t('desktop.imagePreview.copy') }}
        </NButton>
        <NButton quaternary :theme-overrides="buttonTheme" :disabled="busy" @click="save">
          <template #icon>
            <DesktopIcon :component="ArrowDownload24Regular" />
          </template>
          {{ t('desktop.imagePreview.save') }}
        </NButton>
        <NTooltip>
          <template #trigger>
            <NButton class="buddy-icon-button" quaternary :theme-overrides="buttonTheme" :aria-label="t('desktop.imagePreview.close')" @click="emit('close')">
              <template #icon>
                <DesktopIcon :component="Dismiss24Regular" />
              </template>
            </NButton>
          </template>
          {{ t('desktop.imagePreview.close') }} · Esc
        </NTooltip>
      </div>
    </header>

    <div class="relative min-h-0 min-w-0">
      <div ref="stage" class="buddy-image-viewer__stage absolute inset-0 overflow-hidden" @dblclick="toggleSize" />
      <div v-if="failed" class="absolute inset-0 flex items-center justify-center pointer-events-none" role="alert">
        {{ t('desktop.imagePreview.loadFailed') }}
      </div>
      <div v-else-if="!ready" class="absolute inset-0 grid place-items-center pointer-events-none">
        <NSpin size="small" :theme-overrides="{ color: 'var(--buddy-media-overlay-text)' }" />
      </div>
      <template v-if="sources.length > 1">
        <NButton
          v-if="index > 0"
          class="buddy-image-viewer__navigation absolute! left-4 top-1/2 -translate-y-1/2 buddy-icon-button"
          quaternary :theme-overrides="navigationTheme" :aria-label="t('desktop.imagePreview.previous')" @click="navigate(-1)"
        >
          <template #icon>
            <DesktopIcon :component="ChevronLeft24Regular" :size="20" />
          </template>
        </NButton>
        <NButton
          v-if="index < sources.length - 1"
          class="buddy-image-viewer__navigation absolute! right-4 top-1/2 -translate-y-1/2 buddy-icon-button"
          quaternary :theme-overrides="navigationTheme" :aria-label="t('desktop.imagePreview.next')" @click="navigate(1)"
        >
          <template #icon>
            <DesktopIcon :component="ChevronRight24Regular" :size="20" />
          </template>
        </NButton>
      </template>
    </div>

    <footer class="relative flex items-center justify-center px-4 py-4">
      <div class="absolute bottom-full text-xs" role="status" aria-live="polite">
        <span v-if="feedback">{{ t(feedback) }}</span>
      </div>
      <div class="flex items-center justify-center gap-1">
        <NTooltip>
          <template #trigger>
            <NButton class="buddy-icon-button" quaternary :theme-overrides="buttonTheme" :disabled="!ready" :aria-label="t('desktop.imagePreview.zoomOut')" @click="zoomOut">
              <template #icon>
                <DesktopIcon :component="Subtract24Regular" />
              </template>
            </NButton>
          </template>
          {{ t('desktop.imagePreview.zoomOut') }}
        </NTooltip>
        <NTooltip>
          <template #trigger>
            <NButton quaternary :theme-overrides="buttonTheme" :disabled="!ready" :aria-label="t('desktop.imagePreview.originalSize')" @click="originalSize">
              <output class="w-10 text-center text-xs tabular-nums" :aria-label="t('desktop.imagePreview.zoomLevel')">{{ ready ? `${Math.round(ratio * 100)}%` : '—' }}</output>
            </NButton>
          </template>
          {{ t('desktop.imagePreview.originalSize') }} · 100%
        </NTooltip>
        <NTooltip>
          <template #trigger>
            <NButton class="buddy-icon-button" quaternary :theme-overrides="buttonTheme" :disabled="!ready" :aria-label="t('desktop.imagePreview.zoomIn')" @click="zoomIn">
              <template #icon>
                <DesktopIcon :component="Add24Regular" />
              </template>
            </NButton>
          </template>
          {{ t('desktop.imagePreview.zoomIn') }}
        </NTooltip>
        <span class="buddy-image-viewer__divider mx-2 h-4 w-px" aria-hidden="true" />
        <NTooltip v-for="control in transformControls" :key="control.key">
          <template #trigger>
            <NButton class="buddy-icon-button" quaternary :theme-overrides="buttonTheme" :disabled="!ready" :aria-label="t(control.key)" @click="control.action">
              <template #icon>
                <DesktopIcon :component="control.icon" />
              </template>
            </NButton>
          </template>
          {{ t(control.key) }}
        </NTooltip>
      </div>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.buddy-image-viewer {
  color: var(--buddy-media-overlay-text);
  background: var(--buddy-media-overlay-background);
  backdrop-filter: blur(12px);
}

.buddy-image-viewer__stage {
  :deep(.viewer-container) {
    background: transparent;
  }

  :deep(.viewer-canvas) {
    cursor: grab;
  }

  :deep(.viewer-canvas:active) {
    cursor: grabbing;
  }
}

.buddy-image-viewer__navigation:focus-visible {
  outline: 2px solid var(--buddy-media-overlay-focus);
  outline-offset: 2px;
}

.buddy-image-viewer__divider {
  background: var(--buddy-media-overlay-divider);
}
</style>
