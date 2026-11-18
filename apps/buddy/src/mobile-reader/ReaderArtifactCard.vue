<script setup lang="ts">
import type { ReaderOutput, ReaderSend } from './readerProtocol'
import { Document20Regular, Image20Regular, MoreHorizontal20Regular } from '@vicons/fluent'
import { useIntersectionObserver } from '@vueuse/core'
import { shallowRef, useTemplateRef, watch } from 'vue'
import { useReaderStrings } from './readerStrings'

const props = defineProps<{ item: ReaderOutput['items'][number], runId: string, send: ReaderSend }>()
const labels = useReaderStrings()
const card = useTemplateRef('card')
const imageFailed = shallowRef(false)
const visible = shallowRef(false)
useIntersectionObserver(card, entries => visible.value = entries.some(entry => entry.isIntersecting))
watch([visible, () => props.item], ([inView, item]) => {
  if (item.thumbnail)
    imageFailed.value = false
  else if (inView && item.image && item.available)
    props.send({ action: 'artifact-thumbnail', runId: props.runId, resourceId: item.id })
})
</script>

<template>
  <article ref="card" class="artifact-card" :data-artifact-id="item.id">
    <button class="artifact-open" :disabled="!item.available" @click="send({ action: 'artifact', runId, resourceId: item.id })">
      <span class="artifact-preview">
        <img v-if="item.thumbnail && !imageFailed" :src="item.thumbnail" alt="" loading="lazy" @error="imageFailed = true">
        <Image20Regular v-else-if="item.image" class="artifact-icon" />
        <Document20Regular v-else class="artifact-icon" />
      </span>
      <span class="artifact-info">
        <span class="artifact-name">{{ item.name }}</span>
        <span class="artifact-description">{{ item.description }}</span>
      </span>
    </button>
    <button class="artifact-more" :aria-label="`${item.name} · ${labels.artifactActions}`" :disabled="!item.available" @click="send({ action: 'artifact-actions', runId, resourceId: item.id })">
      <MoreHorizontal20Regular class="reader-icon" />
    </button>
  </article>
</template>

<style scoped lang="scss">
.artifact-card {
  position: relative;
  min-width: 0;
  height: 76px;
  overflow: hidden;
  border: 1px solid var(--reader-border);
  border-radius: 6px;
  background: var(--reader-panel);
}
.artifact-open {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 10px 34px 10px 10px;
  background: transparent;
  color: inherit;
  text-align: left;
}
.artifact-preview {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  overflow: hidden;
  border-radius: 4px;
  color: var(--reader-muted);
  background: var(--reader-brush);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}
.artifact-icon {
  width: 26px;
  height: 26px;
}
.artifact-info {
  display: grid;
  min-width: 0;
  gap: 4px;
}
.artifact-name,
.artifact-description {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artifact-name {
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}
.artifact-description {
  color: var(--reader-muted);
  font-size: 11px;
  line-height: 16px;
}
.artifact-more {
  position: absolute;
  top: 18px;
  right: 0;
  display: grid;
  place-items: center;
  width: 36px;
  height: 40px;
  min-height: 40px;
  padding: 0;
  color: var(--reader-muted);
}
.artifact-open:focus-visible,
.artifact-more:focus-visible {
  outline: 2px solid var(--reader-accent);
  outline-offset: -2px;
}
</style>
