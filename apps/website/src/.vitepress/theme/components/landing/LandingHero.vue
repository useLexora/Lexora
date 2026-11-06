<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import LandingDownloadMenu from './LandingDownloadMenu.vue'
import LandingHeroScene from './LandingHeroScene.vue'
import LandingIcon from './LandingIcon.vue'

defineProps<{
  content: LandingContent['hero']
  crew: LandingContent['crew']
  preview: LandingContent['workbench']
  english: boolean
}>()
</script>

<template>
  <section class="hero blue-world" aria-labelledby="hero-title">
    <div class="site-container">
      <div class="hero-layout">
        <div class="hero-copy">
          <p class="product-type">
            {{ content.product }}
          </p>
          <h1 id="hero-title">
            {{ content.title }}
          </h1>
          <p class="hero-description">
            {{ content.description }}
          </p>
          <div class="hero-actions">
            <LandingDownloadMenu :label="content.download" :content="content.downloadMenu" :english="english" />
            <a class="guide-link" :href="withBase(`${english ? '/en' : ''}/guide/quick-start`)">{{ content.guide }}<LandingIcon name="arrow" /></a>
          </div>
          <p class="platforms">
            {{ content.platforms }}
          </p>
        </div>
        <LandingHeroScene :content="content" :crew="crew" :preview="preview" :english="english" />
      </div>
      <a class="hero-next" href="#workspace"><span>{{ content.next }}</span><LandingIcon name="down" /></a>
    </div>
  </section>
</template>

<style scoped>
.hero { padding: 42px 0 0; }
.hero-layout { display: grid; grid-template-columns: .88fr 1.12fr; gap: 54px; align-items: center; min-height: 610px; padding-bottom: 56px; }
.hero-copy { min-width: 0; padding-bottom: 28px; }
.product-type { font-size: 15px; color: var(--crew-light); margin-bottom: 25px; }
.hero-copy h1 { font: 650 clamp(48px, 5.2vw, 76px)/1.18 var(--site-display); letter-spacing: -.045em; white-space: pre-line; }
.hero-description { max-width: 440px; margin-top: 28px; color: var(--crew-light); font-size: 17px; line-height: 1.85; text-wrap: pretty; }
.hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 28px; margin-top: 34px; }
.hero-actions .site-button { min-height: 56px; padding-inline: 27px; font-size: 15px; }
.guide-link { display: inline-flex; align-items: center; min-height: 44px; gap: 10px; color: var(--crew-paper); font-size: 14px; }
.guide-link:hover { text-decoration: underline; }
.guide-link svg { width: 17px; }
.platforms { color: var(--crew-light); font-size: 12px; margin-top: 18px; }
.hero-next { display: flex; justify-content: space-between; align-items: center; min-height: 72px; border-top: 1px solid #c8d5f54d; color: var(--crew-light); font-size: 14px; }
.hero-next svg { width: 20px; height: 20px; color: var(--crew-gold); transition: translate .2s; }
.hero-next:hover { color: var(--crew-paper); }
.hero-next:hover svg { translate: 0 4px; }
@media (max-width: 1100px) and (min-width: 761px) {
  .hero-layout { gap: 30px; min-height: 540px; padding-bottom: 50px; }
  .hero-copy h1 { font-size: clamp(39px, 5vw, 58px); }
  .hero-description { font-size: 15px; }
  .hero-actions { gap: 10px 20px; margin-top: 25px; }
}
@media (max-width: 760px) {
  .hero { padding-top: 32px; }
  .hero-layout { grid-template-columns: minmax(0, 1fr); gap: 28px; padding-bottom: 28px; min-height: 0; }
  .hero-copy { padding: 0; }
  .product-type { font-size: 13px; margin-bottom: 18px; }
  .hero-copy h1 { font-size: clamp(41px, 11.6vw, 62px); line-height: 1.2; }
  .hero-description { font-size: 15px; line-height: 1.8; max-width: 480px; margin-top: 21px; }
  .hero-actions { margin-top: 24px; gap: 10px 20px; }
  .hero-actions .site-button { min-height: 50px; font-size: 14px; padding-inline: 21px; }
  .guide-link { font-size: 13px; }
  .platforms { margin-top: 12px; }
  .hero-next { min-height: 60px; font-size: 13px; }
}
</style>
