<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { resolveCompanionStickerImage } from '@/shared/branding/welcome/companionStickers'

const props = defineProps<{ image: string }>()
const failedSource = shallowRef<string | null>(null)
const source = computed(() => resolveCompanionStickerImage(props.image))
</script>

<template>
  <img
    v-if="source !== failedSource"
    :key="source"
    class="desktop-chat-companion-peeking pointer-events-none select-none absolute right-[1.5rem] bottom-[-0.7rem] z-3 object-contain object-bottom"
    :class="{ '-scale-x-100': image === 'whale' }"
    :src="source"
    alt=""
    draggable="false"
    @error="failedSource = source"
  >
</template>

<style scoped lang="scss">
.desktop-chat-companion-peeking {
  width: calc(var(--welcome-companion-height) + 0.7rem);
  height: calc(var(--welcome-companion-height) + 0.7rem);
}

@container task-pane (max-height: 340px) {
  .desktop-chat-companion-peeking {
    display: none;
  }
}
</style>
