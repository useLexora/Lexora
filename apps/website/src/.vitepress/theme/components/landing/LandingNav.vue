<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { useData, withBase } from 'vitepress'
import { onMounted, shallowRef } from 'vue'
import { downloadUrl, repositoryUrl } from '../../../productLinks'
import LandingIcon from './LandingIcon.vue'

defineProps<{ content: LandingContent['nav'], english: boolean }>()
const expanded = shallowRef(false)
const { isDark } = useData()
const hydrated = shallowRef(false)
onMounted(() => {
  hydrated.value = true
})
</script>

<template>
  <a class="skip-link" href="#main">{{ content.skip }}</a>
  <div class="nav-world blue-world">
    <header class="site-nav site-container" @keydown.esc="expanded = false">
      <a class="brand" :href="withBase(english ? '/en/' : '/')" aria-label="Lexora">
        <img :src="withBase('/landing/lexora-avatar.webp')" alt="" width="36" height="36"><span>Lexora</span>
      </a>
      <nav class="nav-links" :aria-label="english ? 'Main navigation' : '主导航'">
        <a href="#crew">{{ content.crew }}</a>
        <a href="#workspace">{{ content.product }}</a>
        <a href="#plugins">{{ content.plugins }}</a>
        <a :href="withBase(english ? '/en/guide/quick-start' : '/guide/quick-start')">{{ content.guide }}</a>
        <a :href="withBase(english ? '/en/plugins/' : '/plugins/')">{{ content.developers }}</a>
      </nav>
      <div class="nav-actions">
        <div class="display-controls">
          <a class="language-link" :href="withBase(english ? '/' : '/en/')" :aria-label="english ? '切换至简体中文' : 'Switch to English'">{{ english ? '中文' : 'EN' }}</a>
          <button class="theme-toggle" type="button" role="switch" :aria-label="content.darkMode" :aria-checked="hydrated && isDark" :disabled="!hydrated" @click="isDark = !isDark">
            <LandingIcon name="sun" class="theme-sun" />
            <LandingIcon name="moon" class="theme-moon" />
          </button>
        </div>
        <a class="github-link" :href="repositoryUrl" aria-label="GitHub" title="GitHub" target="_blank" rel="noreferrer"><span>GitHub</span></a>
        <a class="nav-download" :href="downloadUrl" target="_blank" rel="noreferrer">{{ content.download }} <LandingIcon name="arrow" /></a>
        <button class="menu-toggle" :aria-label="expanded ? content.close : content.menu" :aria-expanded="expanded" aria-controls="mobile-nav" @click="expanded = !expanded">
          <LandingIcon :name="expanded ? 'close' : 'menu'" />
        </button>
      </div>
      <nav v-if="expanded" id="mobile-nav" class="mobile-nav" :aria-label="english ? 'Mobile navigation' : '移动导航'" @click="expanded = false">
        <a href="#crew">{{ content.crew }}</a>
        <a href="#workspace">{{ content.product }}</a>
        <a href="#plugins">{{ content.plugins }}</a>
        <a :href="withBase(english ? '/en/guide/quick-start' : '/guide/quick-start')">{{ content.guide }}</a>
        <a :href="withBase(english ? '/en/plugins/' : '/plugins/')">{{ content.developers }}</a>
        <a :href="repositoryUrl" target="_blank" rel="noreferrer">GitHub <LandingIcon name="external" /></a>
        <a :href="downloadUrl" target="_blank" rel="noreferrer">{{ content.download }} <LandingIcon name="arrow" /></a>
      </nav>
    </header>
  </div>
</template>

<style scoped>
.site-nav { border-bottom: 1px solid #7890c54a; height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 24px; position: relative; z-index: 5; }
.brand { display: flex; align-items: center; gap: 10px; font-family: var(--site-display); font-size: 27px; font-weight: 650; letter-spacing: -.025em; }
.brand > img { width: 36px; height: 36px; border-radius: 9px; }
.nav-links, .nav-actions { display: flex; align-items: center; gap: 24px; font-size: 13px; }
.nav-links { margin-left: 0; }
.nav-links a, .github-link { color: var(--crew-light); transition: color .2s; }
.nav-links a:hover, .github-link:hover { color: var(--crew-gold); }
.github-link { display: grid; place-items: center; min-width: 58px; height: 44px; border-radius: 7px; }
.github-link span { font-size: 12px; }
.nav-actions { gap: 10px; }
.display-controls { display: flex; align-items: center; border-radius: 6px; }
.theme-toggle, .language-link { display: grid; place-items: center; width: 44px; height: 42px; flex-shrink: 0; border-radius: 7px; color: var(--crew-light); transition: background .2s, color .2s; }
.theme-toggle { cursor: pointer; position: relative; }
.theme-toggle::before { content: ''; position: absolute; left: 0; height: 14px; width: 1px; background: #7890c54a; }
.theme-toggle:hover, .language-link:hover, .github-link:hover { background: #ffffff12; color: var(--crew-gold); }
.theme-toggle svg { width: 18px; height: 18px; }
.theme-sun { display: none; }

.language-link { font-size: 12px; font-weight: 600; }
.nav-download { display: flex; align-items: center; gap: 14px; min-height: 44px; padding: 0 17px; margin-left: 2px; border-radius: 6px; background: var(--crew-gold); color: var(--crew-ink); font-weight: 600; transition: transform .2s, box-shadow .2s; }
.nav-download:hover { transform: translateY(-1px); box-shadow: 0 5px 18px var(--site-shadow); }
.nav-download svg { width: 16px; }
.menu-toggle { display: none; }
.skip-link { position: absolute; top: 10px; left: 16px; padding: 12px 18px; z-index: 20; background: var(--crew-gold); color: var(--crew-ink); transform: translateY(-150%); border-radius: 5px; }
.skip-link:focus { transform: translateY(0); }
@media (max-width: 1000px) { .nav-links { margin-left: 0; gap: 20px; } .github-link { display: none; } }
@media (max-width: 1080px) {
  .site-nav { border-bottom: 1px solid #7890c54a; height: 74px; gap: 12px; }
  .brand { font-size: 27px; gap: 9px; }
  .brand > img { width: 32px; height: 32px; border-radius: 8px; }
  .nav-links, .nav-download { display: none; }
  .nav-actions { gap: 4px; }
  .language-link, .theme-toggle, .menu-toggle { display: grid; place-items: center; min-width: 44px; min-height: 44px; }
  .mobile-nav { position: absolute; top: 66px; right: 0; left: 0; display: flex; flex-direction: column; padding: 16px; border: 1px solid #7890c54a; border-radius: 12px; background: var(--crew-blue); box-shadow: 0 20px 40px var(--site-shadow); }
  .mobile-nav a { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 12px; font-size: 15px; }
  .mobile-nav svg { width: 16px; }
}
</style>
