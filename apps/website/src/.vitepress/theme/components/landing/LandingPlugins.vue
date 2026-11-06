<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import LandingIcon from './LandingIcon.vue'
import LandingImagePreview from './LandingImagePreview.vue'

defineProps<{ content: LandingContent['plugins'], preview: LandingContent['workbench'], english: boolean }>()
</script>

<template>
  <section id="plugins" class="plugins site-container site-section" aria-labelledby="plugins-title">
    <div class="plugin-heading">
      <h2 id="plugins-title">
        {{ content.title }}
      </h2>
      <p>{{ content.description }}</p>
    </div>
    <div class="plugin-examples">
      <article v-for="example in content.examples" :key="example.id" class="plugin-example">
        <h3>{{ example.title }}</h3>
        <p class="example-description">
          {{ example.description }}
        </p>
        <LandingImagePreview :src="`/landing/screenshots/${example.image}${example.id === 'local-models' ? `-${english ? 'en' : 'zh'}` : ''}.webp`" :alt="example.alt" :title="example.title" :enlarge="preview.enlarge" :close="preview.close" :original="preview.original" :width="example.width" :height="example.height" />
        <p class="example-caption">
          {{ example.caption }}
        </p>
        <a class="example-link" :href="withBase(`${english ? '/en' : ''}/guide/${example.guide}`)">{{ preview.guide }}<LandingIcon name="arrow" /></a>
      </article>
    </div>
    <ol class="creation-steps">
      <li v-for="(step, index) in content.steps" :key="step">
        <span>{{ index + 1 }}</span>{{ step }}<LandingIcon v-if="index < content.steps.length - 1" name="arrow" />
      </li>
    </ol>
    <div class="host-capabilities">
      <div><h3>{{ content.hostTitle }}</h3><p>{{ content.hostDescription }}</p></div>
      <ul>
        <li v-for="capability in content.capabilities" :key="capability">
          <LandingIcon name="check" />{{ capability }}
        </li>
      </ul>
    </div>
    <div class="extension-note">
      <div>
        <h3>{{ content.extensionTitle }}</h3><p>{{ content.extensionDescription }}</p>
        <a class="methods-link" :href="withBase(`${english ? '/en' : ''}/guide/skills-and-mcp`)">{{ english ? 'Use Skills and MCP' : '使用 Skills 与 MCP' }}<LandingIcon name="arrow" /></a>
      </div>
      <a class="example-link" :href="withBase(`${english ? '/en' : ''}/guide/plugins`)">{{ content.more }}<LandingIcon name="arrow" /></a>
    </div>
  </section>
</template>

<style scoped>
.plugin-heading { display: grid; grid-template-columns: 1fr 1fr; gap: 64px; align-items: end; margin-bottom: 36px; }
.plugin-heading > p { font-size: 16px; line-height: 1.9; color: var(--site-muted); }
.plugin-examples { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
.plugin-example { min-width: 0; }
.plugin-example h3 { font-size: 22px; line-height: 1.5; }
.example-description { font-size: 15px; line-height: 1.8; color: var(--site-muted); margin: 12px 0 20px; }
.plugin-example :deep(.image-preview) { border: 1px solid var(--site-line); }
.example-caption { font-size: 12px; line-height: 1.8; color: var(--site-muted); margin-top: 12px; }
.example-link, .methods-link { display: inline-flex; align-items: center; gap: 12px; min-height: 44px; color: var(--site-blue); font-size: 14px; }
.example-link:hover, .methods-link:hover { text-decoration: underline; }
.example-link svg, .methods-link svg { width: 18px; flex-shrink: 0; }
.creation-steps { list-style: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 36px 0; padding: 0; border-block: 1px solid var(--site-line); }
.creation-steps li { display: flex; align-items: center; gap: 16px; min-height: 64px; font-size: 15px; padding-right: 24px; }
.creation-steps li > span { color: var(--site-gold); }
.creation-steps svg { width: 18px; margin-left: auto; flex-shrink: 0; color: var(--site-muted); }
.host-capabilities { display: grid; grid-template-columns: 1fr 1fr; gap: 64px; padding-bottom: 32px; border-bottom: 1px solid var(--site-line); }
.host-capabilities h3, .extension-note h3 { font-size: 22px; line-height: 1.5; }
.host-capabilities p, .extension-note p { font-size: 15px; line-height: 1.9; color: var(--site-muted); margin-top: 12px; }
.host-capabilities ul { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 24px; align-content: start; list-style: none; }
.host-capabilities li { display: flex; align-items: center; gap: 10px; font-size: 14px; line-height: 1.7; }
.host-capabilities svg { color: var(--site-blue); width: 18px; flex-shrink: 0; }
.extension-note { display: flex; align-items: center; justify-content: space-between; gap: 48px; padding-top: 32px; }
.extension-note > div { max-width: 760px; }
.extension-note > a { flex-shrink: 0; }
@media (max-width: 1000px) { .plugin-heading, .host-capabilities { gap: 32px; } .creation-steps li { gap: 10px; padding-right: 12px; font-size: 14px; } }
@media (max-width: 760px) {
  .plugin-heading, .host-capabilities { grid-template-columns: 1fr; gap: 24px; }
  .plugin-heading > p { font-size: 15px; }
  .plugin-examples { grid-template-columns: 1fr; gap: 32px; }
  .creation-steps { grid-template-columns: 1fr 1fr; }
  .creation-steps li { min-height: 52px; font-size: 13px; }
  .creation-steps li:nth-child(2) svg { display: none; }
  .host-capabilities ul { gap: 14px; }
  .extension-note { flex-direction: column; align-items: flex-start; gap: 16px; }
}
</style>
