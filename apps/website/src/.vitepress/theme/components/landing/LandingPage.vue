<script setup lang="ts">
import { useData } from 'vitepress'
import { computed } from 'vue'
import LandingCapabilities from './LandingCapabilities.vue'
import { landingContent } from './landingContent'
import LandingFaq from './LandingFaq.vue'
import LandingFinalCta from './LandingFinalCta.vue'
import LandingHero from './LandingHero.vue'
import LandingNav from './LandingNav.vue'
import LandingPlayground from './LandingPlayground.vue'
import LandingWorkbench from './LandingWorkbench.vue'

const { lang } = useData()
const english = computed(() => lang.value.startsWith('en'))
const content = computed(() => landingContent[english.value ? 'en' : 'zh'])
</script>

<template>
  <div id="top" class="landing-page">
    <div class="sky-dust" aria-hidden="true" />
    <LandingNav :content="content.nav" :english="english" />
    <main id="main">
      <LandingHero :content="content.hero" />
      <section class="model-strip site-container" :aria-label="content.models.label">
        <div class="model-strip-heading">
          <span>{{ content.models.label }}</span><span>{{ content.models.note }}</span>
        </div>
        <div class="model-names">
          <span class="model-claude"><i aria-hidden="true">✳</i>Claude</span><span class="model-openai"><i aria-hidden="true">◎</i>OpenAI</span><span class="model-gemini"><i aria-hidden="true">✦</i>Gemini</span><span class="model-deepseek">deepseek</span><span class="model-more">{{ content.models.more }} ↗</span>
        </div>
      </section>
      <LandingPlayground :content="content.demo" />
      <LandingWorkbench :content="content.workbench" :english="english" />
      <LandingCapabilities :content="content.capabilities" />
      <LandingFaq :content="content.faq" />
      <LandingFinalCta :content="content.final" :english="english" />
    </main>
  </div>
</template>

<style scoped>
.landing-page { background: var(--site-bg); color: var(--site-ink); font-family: var(--site-font); position: relative; isolation: isolate; overflow: clip; }
.sky-dust { position: absolute; pointer-events: none; inset: 0 0 auto; height: 850px; z-index: -1; background-image: radial-gradient(circle at 10% 20%, color-mix(in srgb, var(--site-gold) 30%, transparent) 0 1px, transparent 1.5px), radial-gradient(circle at 80% 40%, var(--site-line) 0 1px, transparent 1.5px), radial-gradient(circle at 40% 70%, var(--site-line) 0 1px, transparent 1.5px); background-size: 287px 311px, 419px 383px, 199px 217px; mask-image: linear-gradient(#000, #000a 75%, transparent); }
.model-strip { border-top: 1px solid var(--site-line); border-bottom: 1px solid var(--site-line); padding-top: 23px; padding-bottom: 30px; margin-bottom: 105px; }
.model-strip-heading { display: flex; justify-content: space-between; gap: 20px; font-size: 10px; color: var(--site-faint); }
.model-strip-heading > span:last-child { font-size: 9px; }
.model-names { display: flex; justify-content: space-between; align-items: center; gap: 30px; margin-top: 24px; color: var(--site-muted); }
.model-names > span { display: flex; align-items: center; gap: 7px; font-family: var(--site-display); font-size: 23px; letter-spacing: -.6px; white-space: nowrap; }
.model-names i { font-style: normal; }
.model-claude { font-family: Georgia, serif !important; }
.model-claude i { font-size: 31px; font-weight: 400; }
.model-openai { font-weight: 600; }
.model-gemini { font-weight: 400; }
.model-gemini i { font-size: 27px; }
.model-deepseek { font-weight: 700; letter-spacing: -.9px !important; }
.model-names > .model-more { font-family: var(--site-font); font-size: 11px; color: var(--site-faint); letter-spacing: 0; }
@media (max-width: 760px) {
  .model-strip { margin-bottom: 65px; padding-top: 20px; padding-bottom: 24px; }
  .model-strip-heading { justify-content: center; font-size: 10px; text-align: center; }
  .model-strip-heading > span:last-child { display: none; }
  .model-names { flex-wrap: wrap; justify-content: center; column-gap: 25px; row-gap: 18px; margin-top: 20px; }
  .model-names > span { font-size: 19px; }
  .model-names i { font-size: 22px; }
  .model-names > .model-more { font-size: 10px; }
}
</style>
