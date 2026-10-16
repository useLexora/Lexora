<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import { downloadUrl, repositoryUrl } from '../../../productLinks'
import LandingIcon from './LandingIcon.vue'

defineProps<{ content: LandingContent['final'], english: boolean }>()
</script>

<template>
  <section class="final-cta site-container" aria-labelledby="final-title">
    <div class="final-copy">
      <h2 id="final-title">
        {{ content.title }}
      </h2>
      <p class="final-description">
        {{ content.description }}
      </p>
    </div>
    <div class="final-start">
      <div class="final-actions">
        <a class="site-button" :href="downloadUrl" target="_blank" rel="noreferrer">{{ content.download }}<LandingIcon name="arrow" /></a>
        <a class="text-link" :href="withBase(english ? '/en/guide/quick-start' : '/guide/quick-start')">{{ content.guide }}<LandingIcon name="arrow" /></a>
      </div>
      <p class="platforms">
        {{ content.platforms }}
      </p>
      <p class="platform-note">
        {{ content.note }}
      </p>
    </div>
  </section>
  <footer class="site-footer site-container">
    <div class="footer-identity">
      <a class="footer-brand" :href="withBase(english ? '/en/' : '/')">Lexora</a>
      <p>{{ content.footer }}</p>
    </div>
    <div class="footer-links">
      <a :href="repositoryUrl" target="_blank" rel="noreferrer">{{ content.source }}<LandingIcon name="external" /></a>
      <a :href="`${repositoryUrl}/blob/master/LICENSE`" target="_blank" rel="noreferrer">{{ content.license }}</a>
      <a class="back-top" href="#top" :aria-label="content.back"><LandingIcon name="arrow" /></a>
    </div>
  </footer>
</template>

<style scoped>
.final-cta { display: grid; grid-template-columns: 1.2fr 1fr; gap: 64px; align-items: center; padding-block: 64px 76px; border-top: 1px solid var(--site-line); }
.final-copy h2 { max-width: 620px; font-size: clamp(32px, 3vw, 42px); }
.final-description { margin-top: 20px; color: var(--site-muted); font-size: 16px; line-height: 1.8; }
.final-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px 26px; }
.platforms { margin-top: 23px; font-size: 12px; line-height: 1.8; color: var(--site-muted); }
.platform-note { margin-top: 5px; font-size: 12px; line-height: 1.8; color: var(--site-faint); }
.site-footer { display: flex; justify-content: space-between; align-items: center; gap: 30px; padding-top: 26px; padding-bottom: 32px; border-top: 1px solid var(--site-line); }
.footer-identity { display: flex; align-items: center; gap: 24px; }
.footer-brand { font-family: var(--site-display); font-size: 27px; }
.footer-identity p { font-size: 12px; color: var(--site-faint); }
.footer-links { display: flex; align-items: center; gap: 24px; color: var(--site-muted); font-size: 12px; }
.footer-links a { display: flex; align-items: center; gap: 7px; min-height: 44px; }
.footer-links svg { height: 14px; width: 14px; }
.footer-links .back-top { width: 44px; justify-content: center; }
.back-top svg { transform: rotate(-90deg); width: 19px; height: 19px; }
.footer-links a:hover { color: var(--site-blue); }
@media (max-width: 1100px) { .final-cta { gap: 40px; } .footer-identity { gap: 16px; } }
@media (max-width: 760px) {
  .final-cta { grid-template-columns: 1fr; gap: 28px; padding-block: 42px 48px; }
  .final-description { font-size: 15px; margin-top: 16px; }
  .final-actions { gap: 12px 20px; }
  .site-footer { align-items: flex-start; flex-direction: column; gap: 14px; padding-block: 20px; }
  .footer-identity { align-items: flex-start; flex-direction: column; gap: 5px; }
  .footer-links { width: 100%; gap: 20px; }
  .footer-links .back-top { margin-left: auto; }
}
</style>
