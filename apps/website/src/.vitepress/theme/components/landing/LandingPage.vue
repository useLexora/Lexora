<script setup lang="ts">
import { useData } from 'vitepress'
import { computed } from 'vue'
import { landingContent } from './landingContent'
import LandingFaq from './LandingFaq.vue'
import LandingFilm from './LandingFilm.vue'
import LandingFinalCta from './LandingFinalCta.vue'
import LandingHero from './LandingHero.vue'
import { landingFilm } from './landingMedia'
import LandingNav from './LandingNav.vue'
import LandingPlugins from './LandingPlugins.vue'
import LandingWorkbench from './LandingWorkbench.vue'

const { lang } = useData()
const english = computed(() => lang.value.startsWith('en'))
const content = computed(() => landingContent[english.value ? 'en' : 'zh'])
</script>

<template>
  <div id="top" class="landing-page">
    <LandingNav :content="content.nav" :english="english" />
    <main id="main">
      <LandingHero :content="content.hero" />
      <LandingFilm v-if="landingFilm.src" :content="content.film" />
      <LandingWorkbench :content="content.workbench" :english="english" />
      <LandingPlugins :content="content.plugins" :preview="content.workbench" :english="english" />
      <LandingFaq :content="content.faq" />
      <LandingFinalCta :content="content.final" :english="english" />
    </main>
  </div>
</template>

<style scoped>
.landing-page { background: var(--site-bg); color: var(--site-ink); font-family: var(--site-font); overflow: clip; }
</style>
