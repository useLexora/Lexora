<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NScrollbar } from 'naive-ui'
import { scrollWheelHorizontally } from '@/shared/lib/scrollWheelHorizontally'
import BuddyArtifactCard from './BuddyArtifactCard.vue'

const props = withDefaults(defineProps<{
  artifacts: ReadonlyArray<LocalArtifact>
  language: BuddyLocale
  layout?: 'grid' | 'strip'
}>(), {
  layout: 'strip',
})
const emit = defineEmits<{
  openArtifact: [artifact: LocalArtifact]
}>()

function handleWheel(event: WheelEvent) {
  if (props.layout === 'strip')
    scrollWheelHorizontally(event)
}
</script>

<template>
  <div
    class="buddy-artifact-collection__scroll min-w-0 overflow-hidden"
    :class="`is-${layout}`"
  >
    <NScrollbar class="buddy-artifact-collection__scrollbar" trigger="hover" x-scrollable @wheel="handleWheel">
      <div class="buddy-artifact-collection__items grid items-start gap-2 p-[0.125rem]" :class="`is-${layout}`">
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
    grid-auto-columns: 15rem;
    grid-auto-flow: column;
    padding-bottom: 0.5rem;
  }

  &.is-grid {
    width: 100%;
    grid-template-columns: repeat(auto-fill, minmax(min(15rem, 100%), 1fr));
  }
}
</style>
