<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { computed, shallowRef } from 'vue'
import mascotUrl from '../../../../../../../packages/assets/buddy/pets/default/pet.png'
import LandingIcon from './LandingIcon.vue'

const props = defineProps<{ content: LandingContent['hero'] }>()
const greetingIndex = shallowRef(0)
const greeting = computed(() => props.content.greetings[greetingIndex.value % props.content.greetings.length])
</script>

<template>
  <div class="mascot-stage">
    <div class="mascot-glow" aria-hidden="true" />
    <div class="orbit orbit-one" aria-hidden="true" />
    <div class="orbit orbit-two" aria-hidden="true" />
    <span class="orbit-label orbit-label-top" aria-hidden="true"><i />{{ content.orbitTop }}</span>
    <span class="orbit-label orbit-label-bottom" aria-hidden="true">✧ {{ content.orbitBottom }}</span>
    <span class="star star-one" aria-hidden="true">✦</span>
    <span class="star star-two" aria-hidden="true">✧</span>
    <span class="star star-three" aria-hidden="true">+</span>
    <div class="greeting" aria-live="polite">
      {{ greeting }}<span aria-hidden="true">✧</span>
    </div>
    <button class="mascot-button" :aria-label="content.petAction" @click="greetingIndex++">
      <img :key="greetingIndex" :class="{ 'is-greeting': greetingIndex > 0 }" :src="mascotUrl" alt="" width="1052" height="1156" fetchpriority="high">
    </button>
    <div class="idea-note" aria-hidden="true">
      <div class="idea-icon">
        <LandingIcon name="file" />
      </div>
      <div><strong>{{ content.artifact }}</strong><span>{{ content.artifactStatus }}</span></div>
      <span class="idea-check"><LandingIcon name="check" /></span>
    </div>
    <span class="stage-coordinate" aria-hidden="true">YOUR LITTLE CO-PILOT / 001</span>
  </div>
</template>

<style scoped>
.mascot-stage { height: 570px; position: relative; isolation: isolate; }
.mascot-glow { position: absolute; inset: 10% -8% 0; background: radial-gradient(ellipse, #d5b57712 0, #6d94aa0d 35%, transparent 67%); z-index: -1; }
.orbit { position: absolute; left: 2%; top: 24%; width: 100%; height: 57%; border: 1px solid var(--site-line); border-radius: 50%; transform: rotate(-28deg); }
.orbit-two { left: 11%; top: 8%; width: 76%; height: 90%; transform: rotate(36deg); border-style: dashed; border-color: var(--site-line); }
.orbit-one::before { content: ''; position: absolute; width: 6px; height: 6px; background: var(--site-gold); border-radius: 50%; left: 12%; top: 12%; box-shadow: 0 0 20px #efd39a66; }
.orbit-label { position: absolute; font-size: 11px; letter-spacing: 1px; color: var(--site-muted); }
.orbit-label-top { top: 9%; right: 9%; transform: rotate(8deg); display: flex; gap: 8px; align-items: center; }
.orbit-label-top i { height: 4px; width: 4px; background: var(--site-mint); border-radius: 50%; }
.orbit-label-bottom { bottom: 15%; left: 0; transform: rotate(-9deg); }
.star { position: absolute; color: var(--site-gold); }
.star-one { top: 33%; left: 6%; font-size: 33px; animation: twinkle 5s ease-in-out infinite; }
.star-two { top: 30%; right: 2%; font-size: 42px; }
.star-three { top: 68%; right: 5%; color: var(--site-mint); font-size: 24px; }
.mascot-button { position: absolute; top: 15%; left: 16%; width: 69%; border: none; padding: 0; background: transparent; cursor: pointer; filter: drop-shadow(0 20px 30px #0004); -webkit-tap-highlight-color: transparent; }
.mascot-button img { width: 100%; height: auto; display: block; animation: levitate 6s ease-in-out infinite; transition: filter .2s; }
.mascot-button:hover img { filter: brightness(1.06); }
.mascot-button img.is-greeting { animation: greet .65s ease-in-out, levitate 6s .65s ease-in-out infinite; }
.greeting { position: absolute; z-index: 2; top: 8%; left: 0; max-width: 92%; padding: 13px 18px; border: 1px solid #d4c29738; background: var(--site-raised); border-radius: 13px 13px 3px 13px; color: var(--site-gold); font-size: 12px; transform: rotate(-5deg); box-shadow: 0 8px 30px #0002; }
.greeting span { margin-left: 12px; }
.idea-note { position: absolute; bottom: 6%; right: 0; display: flex; align-items: center; gap: 12px; padding: 16px 18px; background: var(--site-raised); border: 1px solid var(--site-line); border-radius: 10px; box-shadow: 0 16px 40px var(--site-shadow); transform: rotate(4deg); }
.idea-icon { display: grid; place-items: center; width: 36px; height: 40px; border-radius: 5px; background: #e5cb9712; color: var(--site-gold); }
.idea-icon svg { width: 20px; }
.idea-note strong, .idea-note span { display: block; }
.idea-note strong { font-size: 12px; font-weight: 500; margin-bottom: 5px; }
.idea-note div > span { color: var(--site-muted); font-size: 10px; }
.idea-check { margin-left: 10px; color: var(--site-mint); }
.idea-check svg { width: 17px; }
.stage-coordinate { position: absolute; bottom: -3%; left: 14%; font-family: var(--site-mono); font-size: 9px; letter-spacing: 2px; color: var(--site-faint); }
@keyframes levitate { 0%, 100% { transform: translateY(0) rotate(-2deg); } 50% { transform: translateY(-12px) rotate(1deg); } }
@keyframes greet { 0%, 100% { transform: rotate(-2deg); } 25%, 75% { transform: rotate(6deg) translateY(-12px); } 50% { transform: rotate(-6deg) translateY(-12px); } }
@keyframes twinkle { 50% { opacity: .4; transform: scale(.8); } }
@media (max-width: 1100px) and (min-width: 761px) { .mascot-stage { height: 480px; } .greeting { font-size: 10px; } }
@media (max-width: 760px) { .mascot-stage { height: 430px; width: min(100%, 410px); margin: 32px auto 0; text-align: left; } .mascot-button { top: 13%; width: 64%; left: 20%; } .idea-note { bottom: 4%; right: 1%; padding: 12px; } .greeting { top: 5%; left: 4%; } .stage-coordinate { bottom: -5%; } }
@media (max-width: 390px) { .mascot-stage { height: 375px; } .orbit-label { font-size: 9px; } .greeting { font-size: 10px; } }
@media (prefers-reduced-motion: reduce) { .mascot-button img, .mascot-button img.is-greeting, .star { animation: none; } }
</style>
