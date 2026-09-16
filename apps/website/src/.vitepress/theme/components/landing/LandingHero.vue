<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { downloadUrl } from '../../../productLinks'
import LandingIcon from './LandingIcon.vue'
import LandingMascot from './LandingMascot.vue'

defineProps<{ content: LandingContent['hero'] }>()
</script>

<template>
  <section class="hero site-container" aria-labelledby="hero-title">
    <div class="hero-copy">
      <p class="hero-eyebrow">
        <span />{{ content.eyebrow }}
      </p>
      <h1 id="hero-title">
        <span v-for="line in content.title" :key="line">{{ line }}</span>
      </h1>
      <p class="hero-description">
        {{ content.description }}
      </p>
      <div class="hero-actions">
        <a class="site-button" :href="downloadUrl" target="_blank" rel="noreferrer">{{ content.primary }} <LandingIcon name="arrow" /></a>
        <a class="text-link" href="#playground">{{ content.secondary }} <LandingIcon name="down" /></a>
      </div>
      <p class="hero-note">
        <LandingIcon name="check" />{{ content.note }}
      </p>
    </div>
    <LandingMascot :content="content" />
    <a class="scroll-hint" href="#playground"><span class="scroll-line" />{{ content.scroll }}<LandingIcon name="down" /></a>
    <span class="hero-edition" aria-hidden="true">A WORKSPACE WITH A LITTLE SOUL.</span>
  </section>
</template>

<style scoped>
.hero { position: relative; min-height: 715px; display: grid; grid-template-columns: 1.12fr 1fr; gap: 30px; align-items: center; padding-top: 15px; padding-bottom: 100px; }
.hero-copy { padding-top: 15px; position: relative; z-index: 1; }
.hero-eyebrow { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--site-gold); letter-spacing: 1px; margin-bottom: 30px; }
.hero-eyebrow > span { width: 6px; height: 6px; background: var(--site-gold); border-radius: 50%; box-shadow: 0 0 0 5px #e5cb970b; }
h1 { font-family: var(--site-display); font-size: clamp(48px, 5.6vw, 78px); font-weight: 650; line-height: 1.23; letter-spacing: -3px; margin: 0 0 28px; }
h1 span { display: block; }
h1 span:last-child { color: var(--site-gold); }
.hero-description { max-width: 425px; color: var(--site-muted); font-size: 15px; line-height: 2; }
.hero-actions { margin-top: 34px; display: flex; align-items: center; gap: 26px; }
.hero-note { color: var(--site-faint); display: flex; align-items: center; gap: 7px; font-size: 10px; letter-spacing: .3px; margin-top: 20px; }
.hero-note svg { width: 12px; height: 12px; color: var(--site-mint); }
.scroll-hint { display: flex; align-items: center; gap: 12px; position: absolute; left: 0; bottom: 33px; font-size: 10px; color: var(--site-faint); letter-spacing: 1px; }
.scroll-hint svg { width: 12px; }
.scroll-line { width: 34px; height: 1px; background: var(--site-line); }
.hero-edition { position: absolute; right: 0; bottom: 40px; font-size: 9px; font-family: var(--site-mono); letter-spacing: 1.5px; color: var(--site-faint); }
h1:lang(en) { font-size: clamp(48px, 5.1vw, 72px); letter-spacing: -3.5px; line-height: 1.08; }
@media (max-width: 1000px) { .hero { gap: 10px; min-height: 640px; } .hero-actions { gap: 16px; } .hero-description { font-size: 14px; } }
@media (max-width: 760px) {
  .hero { grid-template-columns: 1fr; padding-top: 35px; padding-bottom: 95px; gap: 0; text-align: center; }
  .hero-copy { padding-top: 0; }
  .hero-eyebrow { justify-content: center; font-size: 11px; margin-bottom: 25px; letter-spacing: .5px; }
  h1 { font-size: clamp(46px, 10vw, 70px); line-height: 1.25; letter-spacing: -2px; margin-bottom: 23px; }
  h1:lang(en) { font-size: clamp(47px, 10.5vw, 70px); letter-spacing: -2.5px; }
  .hero-description { margin-inline: auto; max-width: 390px; font-size: 14px; }
  .hero-actions { justify-content: center; gap: 22px; margin-top: 28px; }
  .hero-note { justify-content: center; font-size: 9px; }
  .scroll-hint { left: 50%; transform: translateX(-50%); white-space: nowrap; bottom: 18px; }
  .hero-edition { display: none; }
}
@media (max-width: 390px) { .hero-actions { gap: 15px; } .hero-actions .site-button { padding-inline: 16px; } .hero-actions .text-link { font-size: 11px; } }
</style>
