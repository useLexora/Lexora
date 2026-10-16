<script setup lang="ts">
import type { ChatAssistantAvatarProps } from './typing'

const props = withDefaults(defineProps<ChatAssistantAvatarProps>(), {
  pending: false,
  size: 'md',
})
</script>

<template>
  <div
    class="chat-assistant-avatar"
    :class="[
      `chat-assistant-avatar--${props.size}`,
      { 'is-thinking': props.pending },
    ]"
  >
    <img
      src="/ai-assistant-avatar.png"
      alt=""
      aria-hidden="true"
      draggable="false"
      class="chat-assistant-avatar__image"
    >
  </div>
</template>

<style scoped lang="scss">
.chat-assistant-avatar {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  isolation: isolate;

  &::after {
    position: absolute;
    inset: -0.25rem;
    z-index: -1;
    border-radius: inherit;
    background:
      radial-gradient(
        circle,
        color-mix(in srgb, var(--brand-primary) 18%, transparent) 0%,
        color-mix(in srgb, var(--brand-warning) 10%, transparent) 58%,
        transparent 72%
      );
    content: '';
    opacity: 0;
    transform: scale(0.78);
    transition:
      opacity 180ms ease,
      transform 180ms ease;
  }

  &.is-thinking {
    &::after {
      opacity: 1;
      animation: chat-assistant-avatar-halo 1.8s ease-in-out infinite;
    }
  }
}

.chat-assistant-avatar--md {
  width: 1.75rem;
  height: 1.75rem;
}

.chat-assistant-avatar--sm {
  width: 1.5rem;
  height: 1.5rem;
}

.chat-assistant-avatar--xs {
  width: 1.25rem;
  height: 1.25rem;
}

.chat-assistant-avatar__image {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

@keyframes chat-assistant-avatar-halo {
  0%,
  100% {
    opacity: 0.52;
    transform: scale(0.82);
  }

  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}

@media (prefers-reduced-motion: reduce) {
  .chat-assistant-avatar.is-thinking::after {
    animation: none;
    transform: scale(1);
  }
}
</style>
