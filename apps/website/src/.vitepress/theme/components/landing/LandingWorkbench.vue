<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import { computed, shallowRef, useTemplateRef } from 'vue'
import LandingIcon from './LandingIcon.vue'
import { getProductScreenshots } from './landingMedia'

const props = defineProps<{ content: LandingContent['workbench'], english: boolean }>()
const screenshots = computed(() => getProductScreenshots(props.english))
const selected = shallowRef(0)
const current = computed(() => screenshots.value[selected.value]!)
const preview = useTemplateRef<HTMLDialogElement>('preview')

function openPreview(index: number) {
  selected.value = index
  preview.value?.showModal()
}
</script>

<template>
  <section id="product" class="workbench site-section site-container" aria-labelledby="workbench-title">
    <div class="workbench-heading">
      <p class="eyebrow">
        {{ content.eyebrow }}
      </p>
      <h2 id="workbench-title">
        {{ content.title }}
      </h2>
      <p class="workbench-description">
        {{ content.description }}
      </p>
      <p class="preview-caption">
        {{ content.caption }}
      </p>
    </div>
    <div class="product-gallery">
      <figure v-for="(shot, index) in screenshots" :key="shot.id" class="product-shot">
        <button class="app-preview" :aria-label="`${content.enlarge} · ${shot.title}`" @click="openPreview(index)">
          <img :src="withBase(shot.src)" :alt="shot.alt" :width="shot.width" :height="shot.height" loading="lazy">
          <span class="enlarge-hint"><LandingIcon name="expand" />{{ content.enlarge }}</span>
        </button>
        <figcaption><span class="shot-number">0{{ index + 1 }}</span><div><h3>{{ shot.title }}</h3><p>{{ shot.description }}</p></div></figcaption>
      </figure>
    </div>
    <dialog ref="preview" class="preview-dialog" :aria-label="current.title" @click="event => { if (event.target === preview) preview?.close() }">
      <div class="dialog-toolbar">
        <span>{{ current.title }}</span><button class="dialog-close" :aria-label="content.close" autofocus @click="preview?.close()">
          <LandingIcon name="close" />
        </button>
      </div>
      <img :src="withBase(current.src)" :alt="current.alt" :width="current.width" :height="current.height">
    </dialog>
  </section>
</template>

<style scoped>
.workbench { padding-top: 25px; position: relative; }
.workbench-heading { text-align: center; }
.workbench-description { max-width: 495px; margin: 24px auto 0; font-size: 14px; line-height: 2; color: var(--site-muted); }
.preview-caption { margin-top: 18px; color: var(--site-faint); font-size: 10px; line-height: 1.8; }
.product-gallery { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 34px 24px; margin-top: 46px; }
.product-shot { margin: 0; min-width: 0; }
.app-preview { position: relative; display: block; width: 100%; border-radius: 10px; overflow: hidden; border: 1px solid var(--site-line); padding: 0; cursor: zoom-in; box-shadow: 0 15px 40px var(--site-shadow); background: var(--site-surface); transition: transform .2s, border-color .2s; }
.app-preview:hover { transform: translateY(-3px); border-color: var(--site-gold); }
.app-preview img { display: block; width: 100%; height: auto; }
.enlarge-hint { position: absolute; right: 13px; bottom: 13px; border-radius: 6px; padding: 9px 12px; font-size: 10px; background: #111827ed; color: #f0eee7; display: flex; align-items: center; gap: 8px; opacity: 0; transform: translateY(5px); transition: opacity .2s, transform .2s; }
.enlarge-hint svg { width: 13px; height: 13px; }
.app-preview:hover .enlarge-hint, .app-preview:focus-visible .enlarge-hint { opacity: 1; transform: translateY(0); }
figcaption { display: flex; gap: 14px; padding: 21px 3px 0; }
.shot-number { font-family: var(--site-mono); font-size: 10px; padding-top: 2px; color: var(--site-gold); }
figcaption h3 { font-size: 15px; font-weight: 500; line-height: 1.5; }
figcaption p { font-size: 11px; line-height: 1.8; color: var(--site-muted); margin-top: 7px; }
.preview-dialog { padding: 0; border: 1px solid var(--site-line); border-radius: 10px; max-width: min(95vw, 1600px); max-height: 93vh; margin: auto; background: var(--site-raised); color: var(--site-ink); overflow: auto; }
.preview-dialog::backdrop { background: #070b14db; backdrop-filter: blur(8px); }
.dialog-toolbar { display: flex; align-items: center; justify-content: space-between; padding-left: 20px; font-size: 12px; gap: 18px; }
.preview-dialog > img { display: block; width: auto; max-width: 94vw; max-height: 82vh; object-fit: contain; }
.dialog-close { width: 44px; height: 44px; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; }
.dialog-close:hover { color: var(--site-gold); }
@media (max-width: 760px) {
  .workbench { padding-top: 0; }
  .workbench-description { font-size: 13px; max-width: 350px; }
  .product-gallery { grid-template-columns: minmax(0, 1fr); gap: 28px; margin-top: 28px; }
  figcaption { padding-top: 16px; }
  .enlarge-hint { display: none; }
}
</style>
