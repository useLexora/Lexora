<script setup lang="ts">
withDefaults(defineProps<{
  copied: boolean
  size?: string
}>(), {
  size: '1em',
})
</script>

<template>
  <span
    class="copy-state-icon"
    :class="{ 'is-copied': copied }"
    :style="{ fontSize: size }"
    aria-hidden="true"
  >
    <svg
      class="copy-state-icon__svg"
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
    >
      <path
        class="copy-state-icon__back"
        d="M7.5 7.5V6.75C7.5 5.50736 8.50736 4.5 9.75 4.5H17.25C18.4926 4.5 19.5 5.50736 19.5 6.75V14.25C19.5 15.4926 18.4926 16.5 17.25 16.5H16.5"
      />
      <rect
        class="copy-state-icon__front"
        x="4.5"
        y="7.5"
        width="12"
        height="12"
        rx="2.25"
      />
      <rect
        class="copy-state-icon__success-frame"
        x="4.5"
        y="6"
        width="15"
        height="15"
        rx="2.8"
      />
      <path
        class="copy-state-icon__check"
        pathLength="1"
        d="M8.55 12.8L11.45 15.7L17.35 9.8"
      />
    </svg>
  </span>
</template>

<style scoped lang="scss">
.copy-state-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: currentColor;
  line-height: 1;
  transition: color 0.16s ease;

  &__svg {
    display: block;
    width: 1em;
    height: 1em;
    overflow: visible;
  }

  &__back,
  &__front,
  &__success-frame,
  &__check {
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.7;
    transform-box: fill-box;
    transform-origin: center;
  }

  &__back,
  &__front,
  &__success-frame {
    transition:
      opacity 0.2s ease,
      transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  &__success-frame {
    opacity: 0;
    transform: translateY(0.25px);
  }

  &__check {
    opacity: 0;
    stroke-width: 1.9;
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    transition:
      opacity 0.12s ease,
      stroke-dashoffset 0.36s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  &.is-copied {
    color: var(--brand-success);

    .copy-state-icon__back {
      opacity: 0;
      transform: translate(-1px, 1px);
    }

    .copy-state-icon__front {
      opacity: 0;
      transform: translate(0.5px, -0.5px);
    }

    .copy-state-icon__success-frame {
      opacity: 1;
      transform: translate(0);
    }

    .copy-state-icon__check {
      opacity: 1;
      stroke-dashoffset: 0;
      transition-delay: 0.1s;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .copy-state-icon {
    transition: color 0.12s ease;

    &__back,
    &__front,
    &__success-frame,
    &__check {
      transition: none;
    }
  }
}
</style>
