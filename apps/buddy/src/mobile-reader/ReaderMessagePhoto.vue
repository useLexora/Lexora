<script setup lang="ts">
import type { ReaderMessage } from './readerProtocol'
import { Image20Regular } from '@vicons/fluent'
import { useIntersectionObserver } from '@vueuse/core'
import { computed, inject, shallowRef, useTemplateRef, watch } from 'vue'
import { readerTurnWindowKey } from './readerLoadingPolicy'
import { useReaderStrings } from './readerStrings'

type Resource = ReaderMessage['resources'][number]
const props = defineProps<{ resource: Resource, photo: NonNullable<Resource['photo']> }>()
const emit = defineEmits<{ load: [revision: string, retry: boolean], open: [revision: string] }>()
const labels = useReaderStrings()
const turnWindow = inject(readerTurnWindowKey, undefined)
const slot = useTemplateRef('slot')
const near = shallowRef(false)
const brokenSource = shallowRef<string>()
const loadedSource = shallowRef<string>()
const showReference = computed(() => turnWindow?.value && (props.photo.status !== 'ready' || !props.photo.thumbnail || props.photo.thumbnail === brokenSource.value))
const src = computed(() => near.value && props.photo.status === 'ready' ? props.photo.thumbnail : undefined)
const failed = computed(() => props.photo.status === 'failed' || (!!src.value && src.value === brokenSource.value))
useIntersectionObserver(slot, ([entry]) => near.value = !!entry?.isIntersecting, {
  root: computed(() => slot.value?.closest('.reader-viewport')),
  rootMargin: '160px 0px',
})
watch([near, () => props.photo.status], ([visible, status]) => {
  if (!turnWindow?.value && visible && status === 'idle')
    emit('load', props.photo.revision, false)
})
watch(src, () => {
  brokenSource.value = undefined
  loadedSource.value = undefined
})
function retry() {
  if (!near.value)
    return
  if (props.photo.status === 'failed')
    emit('load', props.photo.revision, true)
  else
    brokenSource.value = undefined
}
</script>

<template>
  <button v-if="showReference" type="button" class="resource-link" :disabled="!resource.available" @click="emit('open', photo.revision)">
    <Image20Regular class="reader-icon resource-icon" aria-hidden="true" />
    <span class="resource-info"><span>{{ resource.name }}</span><small>{{ resource.description }}</small></span>
  </button>
  <div v-else ref="slot" class="message-photo">
    <button
      class="photo-preview" :disabled="!resource.available"
      :aria-label="[labels.openImage, resource.name, resource.description].filter(Boolean).join(' · ')" @click="emit('open', photo.revision)"
    >
      <img v-if="src && !failed" :key="src" :src="src" alt="" @load="loadedSource = ($event.currentTarget as HTMLImageElement).src" @error="brokenSource = ($event.currentTarget as HTMLImageElement).src">
    </button>
    <div v-if="!src || loadedSource !== src || failed" class="photo-placeholder">
      <span v-if="failed || photo.status === 'unavailable'" role="status">{{ labels.unavailableImage }}</span>
      <span v-else-if="near" class="photo-spinner" role="status" :aria-label="labels.loadingImage" />
      <button v-if="failed" class="photo-retry" @click="retry">
        {{ labels.retry }}
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.message-photo {
  position: relative;
  width: min(224px, 92%);
  height: 152px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--reader-brush);
}
.photo-preview,
.photo-preview img {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  object-fit: contain;
}
.photo-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  color: var(--reader-muted);
  font-size: .86em;
}
.photo-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--reader-border);
  border-top-color: var(--reader-accent);
  border-radius: 50%;
  animation: photo-spin .75s linear infinite;
}
@keyframes photo-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .photo-spinner { animation: none; }
}
.photo-retry {
  min-width: 48px;
  min-height: 44px;
  pointer-events: auto;
  color: var(--reader-accent);
}
</style>
