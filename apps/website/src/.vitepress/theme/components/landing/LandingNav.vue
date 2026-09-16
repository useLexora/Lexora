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
  <header class="site-nav site-container" @keydown.esc="expanded = false">
    <a class="brand" :href="withBase(english ? '/en/' : '/')" aria-label="Lexora">
      <LandingIcon /><span>Lexora<span class="brand-dot">.</span></span>
    </a>
    <nav class="nav-links" :aria-label="english ? 'Main navigation' : '主导航'">
      <a href="#playground">{{ content.product }}</a>
      <a href="#capabilities">{{ content.capabilities }}</a>
      <a :href="withBase(english ? '/en/guide/quick-start' : '/guide/quick-start')">{{ content.guide }}</a>
    </nav>
    <div class="nav-actions">
      <div class="display-controls">
        <a class="language-link" :href="withBase(english ? '/' : '/en/')" :aria-label="english ? '切换至简体中文' : 'Switch to English'">{{ english ? '中文' : 'EN' }}</a>
        <button class="theme-toggle" type="button" role="switch" :aria-label="content.darkMode" :aria-checked="hydrated && isDark" :disabled="!hydrated" @click="isDark = !isDark">
          <LandingIcon name="sun" class="theme-sun" />
          <LandingIcon name="moon" class="theme-moon" />
        </button>
      </div>
      <a class="github-link" :href="repositoryUrl" aria-label="GitHub" title="GitHub" target="_blank" rel="noreferrer"><span class="vpi-social-github" aria-hidden="true" /></a>
      <a class="nav-download" :href="downloadUrl" target="_blank" rel="noreferrer">{{ content.download }} <LandingIcon name="arrow" /></a>
      <button class="menu-toggle" :aria-label="expanded ? content.close : content.menu" :aria-expanded="expanded" aria-controls="mobile-nav" @click="expanded = !expanded">
        <LandingIcon :name="expanded ? 'close' : 'menu'" />
      </button>
    </div>
    <nav v-if="expanded" id="mobile-nav" class="mobile-nav" :aria-label="english ? 'Mobile navigation' : '移动导航'" @click="expanded = false">
      <a href="#playground">{{ content.product }}</a>
      <a href="#capabilities">{{ content.capabilities }}</a>
      <a :href="withBase(english ? '/en/guide/quick-start' : '/guide/quick-start')">{{ content.guide }}</a>
      <a :href="repositoryUrl" target="_blank" rel="noreferrer">GitHub <LandingIcon name="external" /></a>
      <a :href="downloadUrl" target="_blank" rel="noreferrer">{{ content.download }} <LandingIcon name="arrow" /></a>
    </nav>
  </header>
</template>

<style scoped>
.site-nav { height: 100px; display: flex; align-items: center; justify-content: space-between; gap: 24px; position: relative; z-index: 5; }
.brand { display: flex; align-items: center; gap: 10px; font-family: var(--site-display); font-size: 32px; font-weight: 700; letter-spacing: -1.8px; }
.brand > svg { width: 28px; height: 28px; color: var(--site-gold); fill: var(--site-gold); stroke-width: .5; transform: rotate(12deg); }
.brand-dot { color: var(--site-gold); }
.nav-links, .nav-actions { display: flex; align-items: center; gap: 30px; font-size: 13px; }
.nav-links { margin-left: 40px; }
.nav-links a, .github-link { color: var(--site-muted); transition: color .2s; }
.nav-links a:hover, .github-link:hover { color: var(--site-gold); }
.github-link { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 7px; }
.github-link span { width: 19px; height: 19px; }
.nav-actions { gap: 10px; }
.display-controls { display: flex; align-items: center; border: 1px solid var(--site-line); border-radius: 8px; background: var(--site-surface); }
.theme-toggle, .language-link { display: grid; place-items: center; width: 44px; height: 42px; flex-shrink: 0; border-radius: 7px; color: var(--site-muted); transition: background .2s, color .2s; }
.theme-toggle { cursor: pointer; position: relative; }
.theme-toggle::before { content: ''; position: absolute; left: 0; height: 14px; width: 1px; background: var(--site-line); }
.theme-toggle:hover, .language-link:hover, .github-link:hover { background: var(--site-accent-soft); color: var(--site-gold); }
.theme-toggle svg { width: 18px; height: 18px; }
.theme-sun { display: none; }

.language-link { font-size: 11px; font-weight: 600; letter-spacing: .4px; }
.nav-download { display: flex; align-items: center; gap: 14px; min-height: 44px; padding: 0 17px; margin-left: 2px; border-radius: 8px; background: var(--site-button-bg); color: var(--site-button-ink); font-weight: 600; transition: transform .2s, box-shadow .2s; }
.nav-download:hover { transform: translateY(-1px); box-shadow: 0 5px 18px var(--site-shadow); }
.nav-download svg { width: 16px; }
.menu-toggle { display: none; }
.skip-link { position: absolute; top: 10px; left: 16px; padding: 12px 18px; z-index: 20; background: var(--site-gold); color: var(--site-bg); transform: translateY(-150%); border-radius: 5px; }
.skip-link:focus { transform: translateY(0); }
@media (max-width: 1000px) { .nav-links { margin-left: 0; gap: 20px; } .github-link { display: none; } }
@media (max-width: 760px) {
  .site-nav { height: 80px; gap: 12px; }
  .brand { font-size: 28px; }
  .nav-links, .nav-download { display: none; }
  .nav-actions { gap: 4px; }
  .language-link, .theme-toggle, .menu-toggle { display: grid; place-items: center; min-width: 44px; min-height: 44px; }
  .mobile-nav { position: absolute; top: 72px; right: 0; left: 0; display: flex; flex-direction: column; padding: 16px; border: 1px solid var(--site-line); border-radius: 12px; background: var(--site-raised); box-shadow: 0 20px 40px var(--site-shadow); }
  .mobile-nav a { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 12px; font-size: 15px; }
  .mobile-nav svg { width: 16px; }
}
</style>
