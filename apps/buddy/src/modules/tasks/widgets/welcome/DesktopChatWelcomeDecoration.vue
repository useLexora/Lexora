<script setup lang="ts">
import type { DesktopChatWelcomeDecoration } from '@/shared/branding/welcome/desktopChatWelcomeVariants'

defineProps<{
  type: DesktopChatWelcomeDecoration
}>()
</script>

<template>
  <svg
    v-if="type === 'underline-star'"
    class="desktop-chat-welcome-decoration is-underline-star"
    viewBox="0 0 360 24"
    aria-hidden="true"
    focusable="false"
  >
    <path class="desktop-chat-welcome-decoration__line stroke-current" d="M18 9.5C102 11.5 232 11.5 324 8.5" />
    <path class="desktop-chat-welcome-decoration__star" d="M341 4.5C342.1 9.1 344.4 11.4 349 12.5C344.4 13.6 342.1 15.9 341 20.5C339.9 15.9 337.6 13.6 333 12.5C337.6 11.4 339.9 9.1 341 4.5Z" />
  </svg>

  <svg
    v-else-if="type === 'orbit-arc'"
    class="desktop-chat-welcome-decoration is-orbit-arc"
    viewBox="0 0 360 30"
    aria-hidden="true"
    focusable="false"
  >
    <path class="desktop-chat-welcome-decoration__line stroke-current" d="M24 25C97 3.5 245 1.5 327 20" />
    <circle cx="331" cy="21" r="2.2" />
    <path class="desktop-chat-welcome-decoration__star" d="M342 14C342.9 17.7 344.8 19.6 348.5 20.5C344.8 21.4 342.9 23.3 342 27C341.1 23.3 339.2 21.4 335.5 20.5C339.2 19.6 341.1 17.7 342 14Z" />
  </svg>
</template>

<style scoped lang="scss">
.desktop-chat-welcome-decoration {
  display: block;
  overflow: visible;
  color: var(--buddy-brand-gold);
  pointer-events: none;
}

.desktop-chat-welcome-decoration__line {
  fill: none;
  stroke-linecap: round;
  stroke-width: 1.25;
}

.desktop-chat-welcome-decoration__star,
circle {
  fill: currentColor;
}

.is-underline-star,
.is-orbit-arc {
  width: calc(100% + 1rem);
  max-width: 23rem;
  margin-top: 0.15rem;
  margin-right: -0.5rem;
  margin-left: -0.5rem;
}

.is-orbit-arc {
  margin-top: 0;
}
</style>
