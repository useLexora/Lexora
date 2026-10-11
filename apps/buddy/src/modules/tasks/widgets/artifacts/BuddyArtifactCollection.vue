<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NScrollbar } from 'naive-ui'
import { useTemplateRef } from 'vue'
import BuddyArtifactCard from './BuddyArtifactCard.vue'

const props = withDefaults(defineProps<{
  artifacts: ReadonlyArray<LocalArtifact>
  language: BuddyLocale
  layout?: 'grid' | 'strip'
}>(), {
  layout: 'strip',
})
const emit = defineEmits<{
  openArtifact: [artifactId: string]
}>()

const scrollRoot = useTemplateRef<HTMLElement>('scrollRoot')

function handleWheel(event: WheelEvent) {
  if (
    props.layout !== 'strip'
    || event.ctrlKey
    || Math.abs(event.deltaX) >= Math.abs(event.deltaY)
  ) {
    return
  }
  const scrollport = findHorizontalScrollport()
  if (!scrollport)
    return
  const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? scrollport.clientWidth
      : 1
  const nextLeft = Math.min(
    Math.max(0, scrollport.scrollLeft + event.deltaY * multiplier),
    scrollport.scrollWidth - scrollport.clientWidth,
  )
  if (Math.abs(nextLeft - scrollport.scrollLeft) < 1)
    return
  event.preventDefault()
  scrollport.scrollLeft = nextLeft
}

function findHorizontalScrollport(): HTMLElement | null {
  return [...scrollRoot.value?.querySelectorAll<HTMLElement>('*') ?? []]
    .find((element) => {
      const overflowX = getComputedStyle(element).overflowX
      return element.scrollWidth > element.clientWidth + 1
        && (overflowX === 'auto' || overflowX === 'scroll')
    }) ?? null
}
</script>

<template>
  <div
    ref="scrollRoot"
    class="buddy-artifact-collection__scroll min-w-0 overflow-hidden"
    :class="`is-${layout}`"
    @wheel="handleWheel"
  >
    <NScrollbar class="buddy-artifact-collection__scrollbar" trigger="hover" x-scrollable>
      <div class="buddy-artifact-collection__items grid gap-[0.625rem] p-[0.125rem]" :class="`is-${layout}`">
        <BuddyArtifactCard
          v-for="artifact in artifacts"
          :key="artifact.artifactId"
          :artifact="artifact"
          :language="language"
          @open-artifact="emit('openArtifact', $event)"
        />
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped lang="scss">
:deep(.buddy-artifact-collection__scrollbar) {
  width: 100%;
}

.buddy-artifact-collection__items {
  &.is-strip {
    width: max-content;
    grid-auto-columns: 17rem;
    grid-auto-flow: column;
    padding-bottom: 0.5rem;
  }

  &.is-grid {
    width: 100%;
    grid-template-columns: repeat(auto-fill, minmax(min(15rem, 100%), 1fr));
  }
}
</style>
