<script setup lang="ts">
import type { EntityAvatarProps } from './typing'
import { useEntityAvatar } from './useEntityAvatar'

const props = withDefaults(defineProps<EntityAvatarProps>(), {
  src: null,
  alt: '',
  size: 40,
  shape: 'circle',
  kind: 'user',
})

const {
  avatarAlt,
  avatarInitial,
  avatarStyle,
  handleImageError,
  resolvedSrc,
} = useEntityAvatar(props)
</script>

<template>
  <div
    class="entity-avatar inline-flex shrink-0 select-none items-center justify-center overflow-hidden"
    :class="[
      `entity-avatar--${props.shape}`,
      `entity-avatar--${props.kind}`,
    ]"
    :style="avatarStyle"
    role="img"
  >
    <img
      v-if="resolvedSrc"
      :key="resolvedSrc"
      :src="resolvedSrc"
      :alt="avatarAlt"
      referrerpolicy="no-referrer"
      class="entity-avatar__image block h-full w-full object-cover"
      @error="handleImageError"
    >

    <span v-else class="entity-avatar__fallback inline-flex h-full w-full items-center justify-center font-bold leading-none">
      {{ avatarInitial }}
    </span>
  </div>
</template>

<style scoped lang="scss">
.entity-avatar {
  color: color-mix(in srgb, var(--brand-text-primary) 84%, var(--brand-primary) 16%);

  &--circle {
    border-radius: 50%;
  }

  &--rounded {
    border-radius: 0.9em;
  }

  &--user {
    background: color-mix(in srgb, var(--brand-fill-light) 72%, var(--brand-bg-surface));
  }

  &--workspace {
    background: color-mix(in srgb, var(--brand-primary) 14%, var(--brand-bg-surface));
  }
}
</style>
