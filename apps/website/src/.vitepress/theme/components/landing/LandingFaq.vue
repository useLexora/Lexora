<script setup lang="ts">
import type { LandingContent } from './landingContent'

defineProps<{ content: LandingContent['faq'] }>()
</script>

<template>
  <section class="faq site-section site-container" aria-labelledby="faq-title">
    <h2 id="faq-title">
      {{ content.title }}
    </h2>
    <div class="questions">
      <details v-for="item in content.items" :key="item.question" class="question">
        <summary class="question-title">
          {{ item.question }}<span class="plus" aria-hidden="true" />
        </summary>
        <p class="question-answer">
          {{ item.answer }}
        </p>
      </details>
    </div>
  </section>
</template>

<style scoped>
.faq { display: grid; grid-template-columns: .8fr 1.5fr; gap: 100px; }
.questions { border-top: 1px solid var(--site-line); }
.question { border-bottom: 1px solid var(--site-line); }
.question-title { display: flex; align-items: center; justify-content: space-between; gap: 24px; list-style: none; cursor: pointer; font-size: 16px; padding: 24px 0; line-height: 1.7; transition: color .2s; }
.question-title:hover, .question[open] .question-title { color: var(--site-blue); }
.question-title::-webkit-details-marker { display: none; }
.plus { height: 15px; width: 15px; position: relative; flex-shrink: 0; }
.plus::before, .plus::after { content: ''; background: currentColor; position: absolute; top: 7px; left: 0; width: 15px; height: 1px; transition: transform .2s; }
.plus::after { transform: rotate(90deg); }
.question[open] .plus::after { transform: rotate(0); }
.question-answer { color: var(--site-muted); font-size: 15px; line-height: 1.9; padding-bottom: 25px; padding-right: 38px; }
@media (max-width: 1100px) { .faq { gap: 48px; } }
@media (max-width: 760px) { .faq { grid-template-columns: 1fr; gap: 30px; } .question-title { font-size: 15px; padding-block: 21px; } .question-answer { font-size: 14px; padding-right: 20px; } }
</style>
