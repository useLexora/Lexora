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
  <span class="desktop-account-avatar" :class="`is-${size}`" aria-hidden="true">
    <img
      v-if="avatarUrl"
      class="desktop-account-avatar__image"
      :src="avatarUrl"
      alt=""
    >
    <span
      v-else-if="resolvedInitials"
      class="desktop-account-avatar__initials"
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

<style scoped>
.desktop-account-avatar {
  display: grid;
  flex: none;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: var(--buddy-avatar-background);
  box-shadow: inset 0 0 0 1px var(--buddy-border-strong);
  color: var(--buddy-avatar-foreground);
  user-select: none;
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
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.desktop-account-avatar__initials {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--buddy-accent-solid);
  color: #ffffff;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.desktop-account-avatar__portrait {
  width: 82%;
  height: 82%;
}
</style>
