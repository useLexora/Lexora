<script setup lang="ts">
import type { LandingContent } from './landingContent'

defineProps<{ content: LandingContent['faq'] }>()
</script>

<template>
  <section class="faq site-section site-container" aria-labelledby="faq-title">
    <div>
      <p class="eyebrow">
        {{ content.eyebrow }}
      </p><h2 id="faq-title">
        {{ content.title }}
      </h2>
    </div>
    <div class="questions">
      <details v-for="item in content.items" :key="item.question">
        <summary>{{ item.question }}<span class="plus" aria-hidden="true" /></summary>
        <p>{{ item.answer }}</p>
      </details>
    </div>
  </section>
</template>

<style scoped>
.faq { display: grid; grid-template-columns: .9fr 1.1fr; gap: 65px; }
.questions { border-top: 1px solid var(--site-line); }
details { border-bottom: 1px solid var(--site-line); }
summary { display: flex; align-items: center; justify-content: space-between; gap: 24px; list-style: none; cursor: pointer; font-size: 14px; padding: 25px 0; line-height: 1.7; transition: color .2s; }
summary:hover, details[open] summary { color: var(--site-gold); }
summary::-webkit-details-marker { display: none; }
.plus { height: 13px; width: 13px; position: relative; flex-shrink: 0; }
.plus::before, .plus::after { content: ''; background: var(--site-muted); position: absolute; top: 6px; left: 0; width: 13px; height: 1px; transition: transform .2s; }
.plus::after { transform: rotate(90deg); }
details[open] .plus::after { transform: rotate(0); }
details > p { color: var(--site-muted); font-size: 13px; line-height: 2; padding-bottom: 25px; padding-right: 32px; }
@media (max-width: 760px) { .faq { grid-template-columns: 1fr; gap: 32px; } summary { font-size: 13px; padding-block: 21px; } details > p { font-size: 12px; padding-right: 15px; } }
</style>
