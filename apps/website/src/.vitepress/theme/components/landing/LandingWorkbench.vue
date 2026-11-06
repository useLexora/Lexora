<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import { computed, shallowRef } from 'vue'
import LandingIcon from './LandingIcon.vue'
import LandingImagePreview from './LandingImagePreview.vue'
import { getProductScreenshots } from './landingMedia'

const props = defineProps<{ content: LandingContent['workbench'], english: boolean }>()
const selected = shallowRef('overview')
const scenes = computed(() => getProductScreenshots(props.english))
const scene = computed(() => scenes.value.find(scene => scene.id === selected.value) ?? scenes.value[0]!)
</script>

<template>
  <section id="workspace" class="workbench site-container site-section" aria-labelledby="workspace-title">
    <div class="section-heading">
      <h2 id="workspace-title">
        {{ content.title }}
      </h2>
      <p>{{ content.description }}</p>
    </div>
    <div class="workspace-showcase">
      <div class="workspace-rail">
        <div class="evidence-selector" :aria-label="content.label">
          <button v-for="item in scenes" :key="item.id" :aria-pressed="selected === item.id" :class="{ active: selected === item.id }" @click="selected = item.id">
            <LandingIcon :name="item.icon" /><span>{{ item.tab }}</span><LandingIcon class="scene-arrow" name="chevron" />
          </button>
        </div>
        <div class="reference-sources" :aria-label="content.sourcesLabel">
          <span v-for="(source, index) in content.sources" :key="source"><LandingIcon :name="['chat', 'file', 'globe'][index]" />{{ source }}</span>
        </div>
      </div>
      <div class="evidence-body">
        <div class="evidence-screen">
          <LandingImagePreview :key="scene.id" :src="scene.src" :alt="scene.alt" :title="scene.title" :enlarge="content.enlarge" :close="content.close" :original="content.original" :width="scene.width" :height="scene.height" />
        </div>
        <div class="evidence-copy" aria-live="polite">
          <h3>{{ scene.title }}</h3><p>{{ scene.description }}</p>
        </div>
        <div class="evidence-caption">
          <div><span>{{ scene.caption }}</span><span class="mobile-crop-note">{{ content.crop }}</span></div>
          <a :href="withBase(scene.guide)">{{ content.guide }}<LandingIcon name="arrow" /></a>
        </div>
      </div>
    </div>
    <div class="everyday-work">
      <h3>{{ content.moreTitle }}</h3>
      <ul class="feature-list">
        <li v-for="feature in content.features" :key="feature.guide">
          <a :href="withBase(`${english ? '/en' : ''}/guide/${feature.guide}`)">{{ feature.title }}<LandingIcon name="arrow" /></a>
          <p>{{ feature.description }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.workbench { padding-top: 96px; }
.section-heading { display: grid; grid-template-columns: 1.2fr 1fr; gap: 100px; align-items: end; margin-bottom: 48px; }
.section-heading h2 { max-width: 560px; font-size: clamp(34px, 3.2vw, 46px); }
.section-heading > p { font-size: 16px; line-height: 1.9; color: var(--site-muted); text-wrap: pretty; }
.workspace-showcase { display: grid; grid-template-columns: 208px minmax(0, 1fr); gap: 36px; align-items: start; }
.workspace-rail { padding-top: 8px; }
.evidence-selector { display: grid; gap: 6px; }
.evidence-selector button { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 12px 15px; border-radius: 8px; font-size: 14px; line-height: 1.5; color: var(--site-muted); text-align: left; cursor: pointer; transition: background .18s, color .18s; }
.evidence-selector button:hover { color: var(--site-ink); background: var(--site-inset); }
.evidence-selector button.active { color: var(--site-button-ink); background: var(--site-button-bg); }
.evidence-selector svg { width: 20px; height: 20px; flex-shrink: 0; }
.evidence-selector .scene-arrow { margin-left: auto; width: 15px; height: 15px; opacity: 0; }
.evidence-selector .active .scene-arrow { opacity: 1; }
.reference-sources { display: grid; gap: 14px; margin: 30px 15px 0; padding-top: 24px; border-top: 1px solid var(--site-line); }
.reference-sources > span { display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--site-muted); }
.reference-sources svg { width: 15px; height: 15px; }
.evidence-screen { padding: 12px; border: 1px solid var(--site-line); border-radius: 16px; background: var(--site-inset); box-shadow: 0 20px 55px var(--site-shadow); }
.evidence-screen :deep(.preview-trigger) { aspect-ratio: 1760 / 1080; border-radius: 6px; }
.evidence-screen :deep(picture) { display: block; height: 100%; }
.evidence-screen :deep(picture > img) { width: 100%; height: 100%; object-fit: contain; }
.evidence-copy { display: grid; grid-template-columns: .8fr 1.2fr; align-items: start; gap: 35px; padding-top: 30px; }
.evidence-copy h3 { font-size: 22px; line-height: 1.5; letter-spacing: -.025em; text-wrap: balance; }
.evidence-copy > p { color: var(--site-muted); font-size: 14px; line-height: 1.85; }
.evidence-caption { margin-top: 16px; display: flex; justify-content: space-between; align-items: center; gap: 20px; font-size: 12px; line-height: 1.8; color: var(--site-faint); }
.evidence-caption > a { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; flex-shrink: 0; font-size: 13px; color: var(--site-blue); }
.evidence-caption > a:hover { text-decoration: underline; }
.evidence-caption > a svg { width: 16px; height: 16px; }
.mobile-crop-note { display: none; }
.everyday-work { margin-top: 60px; padding-top: 38px; border-top: 1px solid var(--site-line); }
.everyday-work > h3 { font-size: 24px; line-height: 1.5; margin-bottom: 24px; }
.feature-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 28px; list-style: none; }
.feature-list a { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; font-size: 16px; color: var(--site-blue); }
.feature-list a:hover { text-decoration: underline; }
.feature-list svg { width: 18px; flex-shrink: 0; }
.feature-list p { font-size: 14px; line-height: 1.8; color: var(--site-muted); margin-top: 8px; }
@media (max-width: 1100px) { .section-heading { gap: 45px; } .workspace-showcase { grid-template-columns: 180px minmax(0, 1fr); gap: 24px; } .evidence-selector button { padding-inline: 12px; font-size: 13px; gap: 9px; } }
@media (max-width: 760px) {
  .workbench { padding-top: 56px; }
  .section-heading { grid-template-columns: 1fr; gap: 20px; margin-bottom: 28px; }
  .section-heading h2 { font-size: 32px; max-width: 440px; }
  .section-heading > p { font-size: 15px; }
  .workspace-showcase { grid-template-columns: 1fr; gap: 22px; }
  .workspace-rail { padding-top: 0; min-width: 0; }
  .evidence-selector { display: flex; overflow-x: auto; gap: 8px; padding: 7px 6px; margin: -7px -6px; scrollbar-width: thin; }
  .evidence-selector button { flex-shrink: 0; min-height: 48px; padding: 10px 14px; gap: 8px; border: 1px solid var(--site-line); }
  .evidence-selector .scene-arrow { display: none; }
  .evidence-selector svg { width: 17px; height: 17px; }
  .reference-sources { display: none; }
  .evidence-screen { padding: 6px; border-radius: 10px; }
  .evidence-screen :deep(.preview-trigger) { border-radius: 4px; }
  .evidence-copy { grid-template-columns: 1fr; gap: 12px; padding-top: 24px; }
  .evidence-copy h3 { font-size: 21px; }
  .evidence-copy > p { font-size: 14px; }
  .evidence-caption { display: block; font-size: 12px; }
  .mobile-crop-note { display: block; margin-top: 5px; }
  .everyday-work { margin-top: 32px; padding-top: 28px; }
  .everyday-work > h3 { font-size: 22px; }
  .feature-list { grid-template-columns: 1fr 1fr; gap: 24px 20px; }
}
</style>
