<script setup lang="ts">
import { BuddyAvatar } from '../modules/buddies/reader'
import { useReaderAvatar } from './useReaderAvatars'

const props = defineProps<{ role: string, authorId: string | null }>()
const source = useReaderAvatar(() => props.authorId)
</script>

<template>
  <span class="message-avatar" aria-hidden="true">
    <BuddyAvatar :buddy-id="authorId ?? undefined" :src="source" />
  </span>
</template>

<style scoped lang="scss">
.message-avatar {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  overflow: hidden;
  border: 1px solid var(--reader-border);
  border-radius: 50%;
  background: var(--reader-user);

  :deep(img) {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  svg {
    width: 21px;
    height: 21px;
  }
}
</style>
