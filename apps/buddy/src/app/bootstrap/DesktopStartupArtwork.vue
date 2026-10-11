<script setup lang="ts">
import avatar from '../../../resources/brand/lexora-avatar.png'

defineProps<{ still: boolean }>()

const stars = [
  { x: '12%', y: '24%', size: '7px', delay: '-0.4s' },
  { x: '29%', y: '14%', size: '5px', delay: '-2.6s' },
  { x: '76%', y: '20%', size: '9px', delay: '-1.6s' },
  { x: '88%', y: '56%', size: '6px', delay: '-0.9s' },
  { x: '19%', y: '72%', size: '8px', delay: '-3.2s' },
  { x: '70%', y: '81%', size: '5px', delay: '-2.1s' },
]
</script>

<template>
  <div class="startup-art absolute inset-0 overflow-hidden isolate pointer-events-none" :class="{ 'is-still': still }" aria-hidden="true">
    <div class="startup-art__aura w-[min(48rem,_80vw)] rounded-full" />
    <svg class="startup-art__constellations absolute inset-0 w-full h-full opacity-20" viewBox="0 0 1440 900" fill="none" preserveAspectRatio="xMidYMid slice">
      <path d="m138 264 83-48 68 35 51-63M1132 187l67 47 36 89M1080 699l84-37 77 45M204 642l64 53 66-21" stroke="currentColor" />
      <g fill="currentColor">
        <circle cx="138" cy="264" r="2" />
        <circle cx="221" cy="216" r="3" />
        <circle cx="289" cy="251" r="2" />
        <circle cx="340" cy="188" r="2" />
        <circle cx="1132" cy="187" r="2" />
        <circle cx="1199" cy="234" r="3" />
        <circle cx="1235" cy="323" r="2" />
        <circle cx="1080" cy="699" r="2" />
        <circle cx="1164" cy="662" r="3" />
        <circle cx="1241" cy="707" r="2" />
        <circle cx="204" cy="642" r="2" />
        <circle cx="268" cy="695" r="3" />
        <circle cx="334" cy="674" r="2" />
      </g>
    </svg>
    <div class="startup-art__orbit startup-art__orbit--gold">
      <div class="startup-art__track absolute inset-0 rounded-full">
        <i /><b />
      </div>
    </div>
    <div class="startup-art__orbit startup-art__orbit--blue">
      <div class="startup-art__track absolute inset-0 rounded-full">
        <i /><b />
      </div>
    </div>
    <div class="startup-art__portrait w-[var(--startup-avatar-size)]">
      <img :src="avatar" alt="" width="1254" height="1254" draggable="false" fetchpriority="high">
    </div>
    <i
      v-for="(star, index) in stars"
      :key="index"
      class="startup-art__star absolute"
      :style="{ left: star.x, top: star.y, width: star.size, height: star.size, animationDelay: star.delay }"
    />
  </div>
</template>

<style scoped lang="scss">
.startup-art {
  --startup-gold: light-dark(#a7803c, #e6c78b);
  --startup-blue: light-dark(#7186a4, #8aa8ce);
}

.startup-art__aura,
.startup-art__orbit,
.startup-art__portrait {
  position: absolute;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  aspect-ratio: 1;
}

.startup-art__aura {
  background:
    radial-gradient(ellipse at 43% 41%, light-dark(#efdab941, #dec49212), transparent 55%),
    radial-gradient(ellipse at 60% 62%, light-dark(#d1dfed52, #779bc31c), transparent 52%);
  animation: startup-breathe 7s ease-in-out infinite;
}

.startup-art__constellations {
  color: var(--startup-gold);
  stroke-width: 0.7;
}

.startup-art__orbit {
  width: min(72rem, 88vw);
  color: var(--startup-gold);
  transform: rotate(-24deg) scaleY(0.42);
}

.startup-art__track {
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  animation: startup-revolve 32s linear infinite;
}

.startup-art__track::before {
  position: absolute;
  inset: -1px;
  border: 1px solid transparent;
  border-top-color: currentColor;
  border-radius: inherit;
  opacity: 0.28;
  content: '';
}

.startup-art__track i,
.startup-art__track b {
  position: absolute;
  top: -3px;
  left: calc(50% - 3px);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 12px color-mix(in srgb, currentColor 55%, transparent);
}

.startup-art__track b {
  top: auto;
  bottom: -2px;
  width: 4px;
  height: 4px;
  opacity: 0.4;
}

.startup-art__orbit--blue {
  width: min(60rem, 76vw);
  color: var(--startup-blue);
  transform: rotate(32deg) scaleY(0.55);
}

.startup-art__orbit--blue .startup-art__track {
  animation-duration: 44s;
  animation-direction: reverse;
}

.startup-art__portrait img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 9px 18px light-dark(#72572d1a, #00000030));
}

.startup-art__star {
  background: var(--startup-gold);
  clip-path: polygon(50% 0, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 39%);
  animation: startup-twinkle 4.8s ease-in-out infinite;
}

.startup-art.is-still {
  opacity: 0.65;
}

.startup-art.is-still * {
  animation: none;
}

@keyframes startup-revolve {
  to { transform: rotate(360deg); }
}

@keyframes startup-breathe {
  0%, 100% { opacity: 0.6; transform: scale(0.96); }
  50% { opacity: 1; transform: scale(1.04); }
}

@keyframes startup-twinkle {
  0%, 100% { opacity: 0.2; transform: scale(0.75); }
  50% { opacity: 0.75; transform: scale(1.1); }
}

@media (prefers-reduced-motion: reduce) {
  .startup-art * { animation: none; }
  .startup-art__star { opacity: 0.5; }
}
</style>
