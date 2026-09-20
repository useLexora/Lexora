<template>
  <span
    aria-hidden="true"
    class="buddy-chat-activity-loader"
  >
    <span class="buddy-chat-activity-loader__orbit buddy-chat-activity-loader__orbit--one" />
    <span class="buddy-chat-activity-loader__orbit buddy-chat-activity-loader__orbit--two" />
    <span class="buddy-chat-activity-loader__orbit buddy-chat-activity-loader__orbit--three" />
    <span class="buddy-chat-activity-loader__core" />
  </span>
</template>

<style scoped lang="scss">
.buddy-chat-activity-loader {
  position: relative;
  isolation: isolate;
  width: var(--buddy-chat-activity-icon-size);
  height: var(--buddy-chat-activity-icon-size);
  flex: 0 0 auto;
  border-radius: 50%;
  perspective: 64px;
  transform-style: preserve-3d;

  &::before {
    position: absolute;
    z-index: -1;
    border-radius: inherit;
    animation: buddy-chat-activity-loader-energy 2.8s ease-in-out infinite;
    background: radial-gradient(
      circle,
      color-mix(in srgb, var(--buddy-accent-text) 26%, transparent) 0%,
      color-mix(in srgb, var(--buddy-accent-text) 9%, transparent) 42%,
      transparent 72%
    );
    content: '';
    inset: 2px;
  }
}

.buddy-chat-activity-loader__orbit {
  --buddy-chat-activity-orbit-color: var(--buddy-accent-text);
  --buddy-chat-activity-orbit-duration: 2.6s;
  --buddy-chat-activity-orbit-rest-angle: 24deg;
  --buddy-chat-activity-orbit-tilt-x: 35deg;
  --buddy-chat-activity-orbit-tilt-y: -45deg;

  position: absolute;
  border: 1px solid color-mix(in srgb, var(--buddy-chat-activity-orbit-color) 12%, transparent);
  border-radius: 50%;
  animation: buddy-chat-activity-loader-orbit var(--buddy-chat-activity-orbit-duration) linear infinite;
  box-sizing: border-box;
  filter: drop-shadow(0 0 1.5px color-mix(in srgb, var(--buddy-chat-activity-orbit-color) 52%, transparent));
  inset: 1px;
  transform: rotateX(var(--buddy-chat-activity-orbit-tilt-x)) rotateY(var(--buddy-chat-activity-orbit-tilt-y)) rotateZ(var(--buddy-chat-activity-orbit-rest-angle));
  transform-style: preserve-3d;
  will-change: opacity, transform;
}

.buddy-chat-activity-loader__orbit--one {
  border-bottom-color: color-mix(in srgb, var(--buddy-chat-activity-orbit-color) 92%, transparent);
}

.buddy-chat-activity-loader__orbit--two {
  --buddy-chat-activity-orbit-duration: 3.4s;
  --buddy-chat-activity-orbit-rest-angle: 138deg;
  --buddy-chat-activity-orbit-tilt-x: 50deg;
  --buddy-chat-activity-orbit-tilt-y: 10deg;

  animation-delay: -1.1s;
  animation-direction: reverse;
  border-right-color: color-mix(in srgb, var(--buddy-chat-activity-orbit-color) 90%, transparent);
  inset: 1.5px;
}

.buddy-chat-activity-loader__orbit--three {
  --buddy-chat-activity-orbit-duration: 2.2s;
  --buddy-chat-activity-orbit-rest-angle: 248deg;
  --buddy-chat-activity-orbit-tilt-x: 35deg;
  --buddy-chat-activity-orbit-tilt-y: 55deg;

  animation-delay: -1.65s;
  border-top-color: color-mix(in srgb, var(--buddy-chat-activity-orbit-color) 88%, transparent);
  inset: 2px;
}

.buddy-chat-activity-loader__core {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  animation: buddy-chat-activity-loader-core 2.8s ease-in-out infinite;
  background: var(--buddy-accent-text);
  box-shadow:
    0 0 2px color-mix(in srgb, var(--buddy-accent-text) 72%, transparent),
    0 0 5px color-mix(in srgb, var(--buddy-accent-text) 56%, transparent);
  transform: translate(-50%, -50%);
}

@keyframes buddy-chat-activity-loader-orbit {
  0% {
    opacity: 0.58;
    transform: rotateX(var(--buddy-chat-activity-orbit-tilt-x)) rotateY(var(--buddy-chat-activity-orbit-tilt-y)) rotateZ(0deg);
  }

  50% {
    opacity: 1;
    transform: rotateX(var(--buddy-chat-activity-orbit-tilt-x)) rotateY(var(--buddy-chat-activity-orbit-tilt-y)) rotateZ(180deg);
  }

  100% {
    opacity: 0.58;
    transform: rotateX(var(--buddy-chat-activity-orbit-tilt-x)) rotateY(var(--buddy-chat-activity-orbit-tilt-y)) rotateZ(360deg);
  }
}

@keyframes buddy-chat-activity-loader-energy {
  0%,
  100% {
    opacity: 0.36;
    transform: scale(0.72);
  }

  50% {
    opacity: 0.9;
    transform: scale(1.18);
  }
}

@keyframes buddy-chat-activity-loader-core {
  0%,
  100% {
    opacity: 0.72;
    transform: translate(-50%, -50%) scale(0.76);
  }

  50% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.16);
  }
}

@media (prefers-reduced-motion: reduce) {
  .buddy-chat-activity-loader::before,
  .buddy-chat-activity-loader__orbit,
  .buddy-chat-activity-loader__core {
    animation: none;
  }
}
</style>
