<script setup lang="ts">
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

withDefaults(defineProps<{
  size?: 'compact' | 'medium' | 'small'
}>(), {
  size: 'small',
})
</script>

<template>
  <span class="desktop-account-avatar" :class="`is-${size}`" aria-hidden="true">
    <DesktopIcon
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
}

.desktop-account-avatar.is-compact {
  width: 28px;
  height: 28px;
}

.desktop-account-avatar.is-small {
  width: 32px;
  height: 32px;
}

.desktop-account-avatar.is-medium {
  width: 48px;
  height: 48px;
}

.desktop-account-avatar__portrait {
  width: 82%;
  height: 82%;
}
</style>
