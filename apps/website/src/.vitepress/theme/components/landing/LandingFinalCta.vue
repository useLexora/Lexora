<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import { downloadUrl, repositoryUrl } from './landingContent'
import LandingIcon from './LandingIcon.vue'

defineProps<{ content: LandingContent['final'], english: boolean }>()
</script>

<template>
  <section class="final-cta site-container" aria-labelledby="final-title">
    <span class="final-star star-left" aria-hidden="true">✧</span><span class="final-star star-right" aria-hidden="true">✦</span>
    <p class="eyebrow">
      {{ content.eyebrow }}
    </p>
    <h2 id="final-title">
      {{ content.title }}
    </h2>
    <p class="final-description">
      {{ content.description }}
    </p>
    <div class="final-actions">
      <a class="site-button" :href="downloadUrl" target="_blank" rel="noreferrer">{{ content.download }}<LandingIcon name="arrow" /></a><a class="text-link" :href="withBase(english ? '/en/guide/quick-start' : '/guide/quick-start')">{{ content.guide }}<LandingIcon name="arrow" /></a>
    </div>
    <p class="platforms">
      {{ content.platforms }}
    </p><p class="platform-note">
      {{ content.note }}
    </p>
  </section>
  <footer class="site-footer site-container">
    <div><a class="footer-brand" :href="withBase(english ? '/en/' : '/')"><LandingIcon />Lexora.</a><p>{{ content.footer }}</p></div>
    <div class="footer-links">
      <a :href="repositoryUrl" target="_blank" rel="noreferrer">{{ content.source }}<LandingIcon name="external" /></a><a :href="`${repositoryUrl}/blob/master/LICENSE`" target="_blank" rel="noreferrer">{{ content.license }}</a><a href="#top" :aria-label="content.back">↑</a>
    </div>
  </footer>
</template>

<style scoped>
.final-cta { position: relative; text-align: center; padding: 75px 0 85px; border-top: 1px solid var(--site-line); }
.final-cta::before { content: ''; position: absolute; pointer-events: none; width: 600px; max-width: 100%; height: 500px; top: -30px; left: 50%; transform: translateX(-50%); border-radius: 50%; background: radial-gradient(ellipse, #c6a57409, transparent 65%); }
.final-cta h2 { font-size: clamp(40px, 5vw, 64px); position: relative; }
.final-description { margin-top: 24px; color: var(--site-muted); font-size: 14px; }
.final-actions { margin-top: 30px; display: flex; justify-content: center; align-items: center; gap: 26px; position: relative; }
.platforms { margin-top: 28px; font-size: 11px; color: var(--site-muted); }
.platform-note { margin-top: 8px; font-size: 10px; color: var(--site-faint); }
.final-star { position: absolute; color: var(--site-gold); }
.star-left { font-size: 45px; top: 32%; left: 9%; transform: rotate(-12deg); }
.star-right { font-size: 20px; top: 52%; right: 13%; }
.site-footer { display: flex; justify-content: space-between; align-items: center; gap: 30px; padding-top: 30px; padding-bottom: 40px; border-top: 1px solid var(--site-line); }
.footer-brand { display: flex; align-items: center; gap: 8px; font-family: var(--site-display); font-size: 23px; font-weight: 700; letter-spacing: -1px; }
.footer-brand svg { color: var(--site-gold); width: 18px; height: 18px; }
.site-footer p { font-size: 10px; color: var(--site-faint); margin-top: 9px; }
.footer-links { display: flex; align-items: center; gap: 24px; color: var(--site-muted); font-size: 10px; }
.footer-links a { display: flex; align-items: center; gap: 7px; }
.footer-links svg { height: 11px; width: 11px; }
.footer-links a:last-child { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--site-line); border-radius: 50%; font-size: 17px; }
.footer-links a:hover { color: var(--site-gold); }
@media (max-width: 760px) {
  .final-cta { padding: 60px 0; }
  .final-description { font-size: 12px; }
  .final-actions { gap: 18px; }
  .final-actions .text-link { font-size: 11px; }
  .final-star { display: none; }
  .site-footer { align-items: flex-start; flex-direction: column; gap: 25px; }
  .footer-links { width: 100%; gap: 20px; }
  .footer-links a:last-child { margin-left: auto; }
}
</style>
