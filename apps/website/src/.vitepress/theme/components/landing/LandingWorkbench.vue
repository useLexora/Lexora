<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import { computed, shallowRef } from 'vue'
import LandingIcon from './LandingIcon.vue'
import LandingImagePreview from './LandingImagePreview.vue'
import { getProductScreenshots } from './landingMedia'

const props = defineProps<{ content: LandingContent['workbench'], english: boolean }>()
const selected = shallowRef('workspace')
const scenes = computed(() => getProductScreenshots(props.english))
const scene = computed(() => scenes.value.find(scene => scene.id === selected.value) ?? scenes.value[0]!)
</script>

<template>
  <section id="workspace" class="workbench site-container site-section" aria-labelledby="workspace-title">
    <div class="section-heading">
      <div>
        <h2 id="workspace-title">
          {{ content.title }}
        </h2>
      </div>
      <div class="workspace-intro">
        <p>{{ content.description }}</p><div class="reference-sources" :aria-label="content.sourcesLabel">
          <span v-for="(source, index) in content.sources" :key="source"><LandingIcon :name="['chat', 'file', 'globe'][index]" />{{ source }}</span>
        </div>
      </div>
    </div>
    <div class="evidence-selector" :aria-label="content.label">
      <button v-for="(item, index) in scenes" :key="item.id" :aria-pressed="selected === item.id" :class="{ active: selected === item.id }" @click="selected = item.id">
        <span class="scene-number">0{{ index + 1 }}</span>{{ item.tab }}<LandingIcon name="arrow" />
      </button>
    </div>
    <div class="evidence-body">
      <div class="evidence-copy" aria-live="polite">
        <h3>{{ scene.title }}</h3><p>{{ scene.description }}</p>
      </div>
      <LandingImagePreview :key="scene.id" :src="scene.src" :alt="scene.alt" :title="scene.title" :enlarge="content.enlarge" :close="content.close" :original="content.original" :width="scene.width" :height="scene.height" :mobile-position="scene.mobilePosition" :mobile-src="scene.mobileSrc" :mobile-width="scene.mobileWidth" :mobile-height="scene.mobileHeight" />
      <div class="evidence-caption">
        <div><span>{{ scene.caption }}</span><span class="mobile-crop-note">{{ content.crop }}</span></div>
        <a :href="withBase(scene.guide)">{{ english ? 'Learn how' : '查看操作指南' }}<LandingIcon name="arrow" /></a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.workbench { padding-top: 88px; }
.section-heading { display: grid; grid-template-columns: 1.1fr 1fr; gap: 80px; align-items: end; margin-bottom: 39px; }
.workspace-intro > p { font-size: 15px; line-height: 1.9; color: var(--site-muted); }
.reference-sources { display: flex; flex-wrap: wrap; gap: 12px 20px; margin-top: 23px; }
.reference-sources > span { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--site-blue); }
.reference-sources svg { width: 15px; height: 15px; }
.evidence-selector { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-block: 1px solid var(--site-line); }
.evidence-selector button { display: flex; align-items: center; justify-content: flex-start; gap: 14px; min-height: 73px; padding: 0 24px; font-size: 15px; color: var(--site-muted); cursor: pointer; position: relative; text-align: left; }
.evidence-selector button + button { border-left: 1px solid var(--site-line); }
.evidence-selector button.active { color: var(--site-blue); background: var(--site-accent-soft); }
.evidence-selector button.active::after { content: ''; height: 3px; position: absolute; bottom: -1px; left: 0; right: 0; background: var(--site-blue); }
.scene-number { font: 500 11px var(--site-mono); opacity: .7; }
.evidence-selector svg { width: 17px; height: 17px; margin-left: auto; }
.evidence-body { padding-top: 28px; }
.evidence-copy { display: grid; grid-template-columns: 1fr 1.6fr; align-items: start; gap: 50px; padding-bottom: 25px; }
.evidence-copy h3 { font-size: 21px; line-height: 1.5; letter-spacing: -.02em; }
.evidence-copy > p { color: var(--site-muted); font-size: 13px; line-height: 1.9; max-width: 690px; }
.evidence-body :deep(.image-preview) { border: 1px solid var(--site-line); box-shadow: 0 14px 45px var(--site-shadow); }
.evidence-caption { margin-top: 15px; display: flex; justify-content: space-between; align-items: center; gap: 20px; font-size: 11px; line-height: 1.8; color: var(--site-muted); }
.evidence-caption > a { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; flex-shrink: 0; font-size: 13px; color: var(--site-blue); }
.evidence-caption > a:hover { text-decoration: underline; }
.evidence-caption > a svg { width: 16px; height: 16px; }
.mobile-crop-note { display: none; }
@media (max-width: 1000px) { .section-heading { gap: 40px; } .evidence-selector button { padding-inline: 15px; gap: 9px; font-size: 13px; } }
@media (max-width: 760px) {
  .workbench { padding-top: 54px; } .section-heading { grid-template-columns: 1fr; gap: 22px; margin-bottom: 27px; } .workspace-intro > p { font-size: 13px; } .reference-sources { margin-top: 18px; gap: 10px 15px; } .reference-sources > span { font-size: 10px; }
  .evidence-selector { grid-template-columns: 1fr 1fr; }
  .evidence-selector button { gap: 10px; min-height: 58px; padding-inline: 12px; font-size: 12px; line-height: 1.5; } .evidence-selector svg { display: none; } .scene-number { font-size: 10px; }
  .evidence-selector button:nth-child(3) { border-left: 0; } .evidence-selector button:nth-child(n+3) { border-top: 1px solid var(--site-line); }
  .evidence-body { padding-top: 23px; } .evidence-copy { grid-template-columns: 1fr; gap: 12px; padding-bottom: 20px; } .evidence-copy h3 { font-size: 20px; } .evidence-copy > p { font-size: 12px; }
  .evidence-caption { display: block; font-size: 10px; } .mobile-crop-note { display: block; margin-top: 5px; }
}
</style>
