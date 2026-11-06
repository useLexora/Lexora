<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import LandingIcon from './LandingIcon.vue'

defineProps<{ content: LandingContent['local'], english: boolean }>()
</script>

<template>
  <section id="local-first" class="local-first site-section" aria-labelledby="local-title">
    <div class="site-container">
      <div class="local-heading">
        <h2 id="local-title">
          {{ content.title }}
        </h2>
        <p>{{ content.description }}</p>
      </div>
      <div class="local-choices">
        <article v-for="item in content.items" :key="item.guide">
          <h3>{{ item.title }}</h3>
          <p>{{ item.description }}</p>
          <a :href="withBase(`${english ? '/en' : ''}/guide/${item.guide}`)">{{ item.link }}<LandingIcon name="arrow" /></a>
        </article>
      </div>
      <p class="local-note">
        {{ content.note }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.local-first { padding-top: 56px; background: var(--site-inset); margin-bottom: 80px; }
.local-heading { display: grid; grid-template-columns: 1fr 1fr; gap: 64px; align-items: end; }
.local-heading p { font-size: 16px; line-height: 1.9; color: var(--site-muted); }
.local-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 36px; margin-top: 36px; }
.local-choices h3 { font-size: 21px; line-height: 1.5; }
.local-choices p { font-size: 15px; line-height: 1.9; color: var(--site-muted); margin-top: 12px; }
.local-choices a { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; color: var(--site-blue); font-size: 14px; margin-top: 12px; }
.local-choices a:hover { text-decoration: underline; }
.local-choices svg { width: 18px; flex-shrink: 0; }
.local-note { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--site-line); font-size: 13px; line-height: 1.9; color: var(--site-muted); }
@media (max-width: 760px) {
  .local-first { padding-top: 40px; margin-bottom: 56px; }
  .local-heading, .local-choices { grid-template-columns: 1fr; gap: 24px; }
  .local-heading p { font-size: 15px; }
}
</style>
