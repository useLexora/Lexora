<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import LandingImagePreview from './LandingImagePreview.vue'

defineProps<{
  content: LandingContent['hero']
  crew: LandingContent['crew']
  preview: LandingContent['workbench']
  english: boolean
}>()
</script>

<template>
  <div class="hero-scene">
    <a class="lead-portrait" href="#crew" :aria-label="`${content.meet} · Lexora`">
      <img :src="withBase('/landing/lexora-avatar.webp')" :alt="crew.leadAlt" width="1254" height="1254" fetchpriority="high">
      <span>Lexora</span>
    </a>
    <a v-for="companion in crew.companions" :key="companion.id" class="scene-companion" :class="`companion-${companion.id}`" href="#crew" :aria-label="`${content.meet} · ${companion.name}`">
      <img :src="withBase(`/landing/companions/${companion.id}.webp`)" :alt="companion.alt" width="512" height="512">
      <span>{{ companion.name }}</span>
    </a>
    <div class="scene-prompt">
      <p>“{{ content.prompt }}”</p>
    </div>
    <figure class="hero-result">
      <LandingImagePreview :src="`/landing/screenshots/readme-local-image-${english ? 'en' : 'zh'}.webp`" :thumbnail="{ src: `/landing/hero-kitten-${english ? 'en' : 'zh'}.webp`, width: 512, height: 512 }" :alt="content.alt" :title="content.example" :enlarge="preview.enlarge" :close="preview.close" :original="preview.original" :width="1760" :height="1000" eager />
      <figcaption>
        <strong>{{ content.result }}</strong>
        <span>{{ content.caption }}</span>
      </figcaption>
    </figure>
  </div>
</template>

<style scoped>
.hero-scene { position: relative; min-width: 0; width: 100%; aspect-ratio: 1.16; isolation: isolate; animation: scene-arrive .7s ease-out both; }
.lead-portrait { position: absolute; top: 5%; left: 11%; width: 53%; padding: 10px 10px 0; background: var(--crew-paper); color: var(--crew-ink); transform: rotate(-7deg); border-radius: 46% 46% 8px 8px; box-shadow: 0 20px 36px #10204b40; transition: transform .25s; }
.lead-portrait > img { display: block; width: 100%; height: auto; border-radius: 46% 46% 2px 2px; }
.lead-portrait > span { display: block; padding: 12px 4px 14px; text-align: center; font: 650 clamp(24px, 2.4vw, 34px)/1 var(--site-display); letter-spacing: -.04em; }
.lead-portrait:hover, .lead-portrait:focus-visible { transform: rotate(-3deg) translateY(-5px); }
.scene-companion { position: absolute; width: 22%; color: var(--crew-paper); transition: transform .25s; }
.scene-companion > img { display: block; width: 100%; height: auto; border-radius: 50%; border: 5px solid var(--crew-paper); box-shadow: 0 8px 24px #10204b33; }
.scene-companion > span { display: block; padding-top: 8px; text-align: center; font-size: 14px; }
.companion-deepseek { left: 0; top: 65%; transform: rotate(-10deg); }
.companion-claude { left: 27%; top: 76%; transform: rotate(7deg); }
.companion-chatgpt { right: 0; top: -2%; transform: rotate(9deg); }
.scene-companion:hover, .scene-companion:focus-visible { transform: rotate(0deg) translateY(-5px); }
.scene-prompt { position: absolute; top: 31%; right: 0; width: 33%; padding: 15px 18px; border: 1px solid #f8f0dc66; border-radius: 16px 16px 3px 16px; background: var(--crew-deep); color: var(--crew-paper); transform: rotate(3deg); }
.scene-prompt > p { font-size: 14px; line-height: 1.65; text-wrap: balance; }
.hero-result { position: absolute; right: 0; top: 48%; width: 38%; padding: 9px; background: var(--crew-paper); color: var(--crew-ink); box-shadow: 0 18px 35px #10204b40; transform: rotate(6deg); border-radius: 3px; }
.hero-result :deep(.preview-trigger) { background: var(--crew-paper); }
.hero-result :deep(.preview-hint) { right: 8px; bottom: 8px; padding: 8px; }
.hero-result :deep(.preview-hint span) { display: none; }
.hero-result :deep(.preview-hint svg) { width: 20px; height: 20px; }
.hero-result figcaption { display: grid; gap: 5px; padding: 12px 5px 7px; }
.hero-result strong { font-size: 15px; font-weight: 600; line-height: 1.5; }
.hero-result figcaption > span { color: #526078; font-size: 12px; line-height: 1.5; }
@keyframes scene-arrive { from { opacity: 0; translate: 0 14px; } to { opacity: 1; translate: 0 0; } }
@media (max-width: 1100px) and (min-width: 761px) {
  .scene-prompt { padding: 10px; } .scene-prompt > p { font-size: 12px; }
  .hero-result strong { font-size: 13px; } .hero-result figcaption > span { font-size: 12px; }
}
@media (max-width: 760px) {
  .hero-scene { max-width: 500px; min-height: 360px; margin-inline: auto; aspect-ratio: 1.02; }
  .lead-portrait { top: 5%; padding: 7px 7px 0; }
  .lead-portrait > span { font-size: 25px; padding: 9px 2px 11px; }
  .scene-companion > img { border-width: 3px; }
  .scene-companion > span { font-size: 12px; padding-top: 5px; }
  .companion-deepseek { top: 65%; } .companion-claude { top: 76%; }
  .scene-prompt { top: 30%; width: 34%; padding: 9px; border-radius: 12px 12px 2px 12px; }
  .scene-prompt > p { font-size: 12px; line-height: 1.5; }
  .hero-result { top: 54%; width: 40%; padding: 6px; }
  .hero-result figcaption { gap: 3px; padding: 8px 2px 4px; }
  .hero-result strong { font-size: 12px; }
  .hero-result figcaption > span { display: none; }
}
</style>
