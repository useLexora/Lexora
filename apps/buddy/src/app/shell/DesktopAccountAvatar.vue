<script setup lang="ts">
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { extractInitials } from './userProfile'

const props = withDefaults(defineProps<{
  avatarUrl?: string | null
  backgroundColor?: string
  initials?: string
  name?: string
  size?: 'compact' | 'large' | 'medium' | 'small'
}>(), {
  avatarUrl: null,
  backgroundColor: undefined,
  initials: undefined,
  name: undefined,
  size: 'small',
})

const resolvedInitials = computed(() => {
  if (props.initials)
    return props.initials
  if (props.name)
    return extractInitials(props.name)
  return null
})
</script>

<template>
  <span class="desktop-account-avatar grid flex-none place-items-center overflow-hidden rounded-full bg-avatar text-avatar-foreground select-none" :class="`is-${size}`" aria-hidden="true">
    <img
      v-if="avatarUrl"
      class="desktop-account-avatar__image w-full h-full rounded-full"
      :src="avatarUrl"
      alt=""
    >
    <span
      v-else-if="resolvedInitials"
      class="desktop-account-avatar__initials flex w-full h-full items-center justify-center rounded-full bg-accent font-600"
      :style="backgroundColor ? { backgroundColor } : undefined"
    >
      {{ resolvedInitials }}
    </span>
    <DesktopIcon
      v-else
      class="desktop-account-avatar__portrait"
      name="accountAvatar"
    />
  </span>
</template>

<style scoped lang="scss">
.desktop-account-avatar {
  box-shadow: inset 0 0 0 1px var(--buddy-border-strong);
}

.desktop-account-avatar.is-compact {
  width: 28px;
  height: 28px;
  font-size: 12px;
}

.desktop-account-avatar.is-small {
  width: 32px;
  height: 32px;
  font-size: 13px;
}

.desktop-account-avatar.is-medium {
  width: 48px;
  height: 48px;
  font-size: 18px;
}

.desktop-account-avatar.is-large {
  width: 64px;
  height: 64px;
  font-size: 24px;
}

.desktop-account-avatar__image {
  object-fit: cover;
}

.desktop-account-avatar__initials {
  color: #ffffff;
  letter-spacing: 0.02em;
}

.desktop-account-avatar__portrait {
  width: 82%;
  height: 82%;
}
</style>
