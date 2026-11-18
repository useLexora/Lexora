<script setup lang="ts">
import { Image20Regular } from '@vicons/fluent'
import { useIntersectionObserver } from '@vueuse/core'
import { computed, inject, shallowRef, useTemplateRef, watch } from 'vue'
import { useReaderStrings } from './readerStrings'
import { readerToolImageHostKey, readerToolImagesKey } from './readerToolImages'

const props = defineProps<{ ids: string[], toolCallId?: string, kind: 'reference' | 'artifact' }>()
const host = inject(readerToolImageHostKey)!
const images = inject(readerToolImagesKey)!
const labels = useReaderStrings()
const gallery = useTemplateRef('gallery')
const visible = shallowRef(false)
const failed = shallowRef(new Set<string>())
const items = computed(() => props.ids.map(id => ({ id, state: images.value.find(image => image.runId === host.runId.value && image.toolCallId === props.toolCallId && image.kind === props.kind && image.id === id) })))
useIntersectionObserver(gallery, entries => visible.value = entries.some(entry => entry.isIntersecting))
function request(id: string, retry = false) {
  if (!props.toolCallId)
    return
  failed.value = new Set([...failed.value].filter(value => value !== id))
  host.send({ action: 'tool-image', runId: host.runId.value, toolCallId: props.toolCallId, kind: props.kind, id, ...(retry ? { retry: 'true' } : {}) })
}
watch([visible, items], ([inView, items]) => {
  if (inView) {
    for (const item of items) {
      if (!item.state || (!item.state.loading && !item.state.failed && !item.state.thumbnail))
        request(item.id)
    }
  }
})
function open(id: string) {
  if (props.toolCallId)
    host.send({ action: 'tool-image-preview', runId: host.runId.value, toolCallId: props.toolCallId, kind: props.kind, id })
}
</script>

<template>
  <div v-if="items.length" ref="gallery" class="reader-tool-images grid gap-2 px-2 py-1.5" :data-image-kind="kind">
    <figure v-for="item in items" :key="item.id" class="m-0 min-w-0">
      <button
        class="tool-image-preview" :disabled="!item.state?.available" :aria-label="`${labels.openImage}${item.state?.name ? ` · ${item.state.name}` : ''}`"
        @click="open(item.id)"
      >
        <img v-if="item.state?.thumbnail && !failed.has(item.id)" :src="item.state.thumbnail" alt="" @error="failed = new Set(failed).add(item.id)">
        <span v-else class="grid justify-items-center gap-2 text-xs text-[var(--reader-muted)]" role="status">
          <Image20Regular class="h-6 w-6" aria-hidden="true" />
          {{ item.state?.failed || failed.has(item.id) ? labels.unavailableImage : labels.loadingImage }}
        </span>
      </button>
      <figcaption v-if="item.state?.name" class="mt-1 truncate text-xs text-[var(--reader-muted)]">
        {{ item.state.name }}
      </figcaption>
      <button v-if="item.state?.failed || failed.has(item.id)" class="tool-image-retry" @click="request(item.id, true)">
        {{ labels.retry }}
      </button>
    </figure>
  </div>
</template>

<style scoped lang="scss">
.reader-tool-images {
  grid-auto-flow: column;
  grid-auto-columns: 112px;
  justify-content: start;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.tool-image-preview {
  display: grid;
  width: 100%;
  height: 80px;
  place-items: center;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--reader-border);
  border-radius: 6px;
  background: var(--reader-brush);
  cursor: pointer;

  img {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
    object-fit: contain;
  }
}
.tool-image-retry {
  padding: 4px 8px;
  border: 0;
  background: transparent;
  color: var(--reader-accent);
  font-size: 12px;
}
</style>
