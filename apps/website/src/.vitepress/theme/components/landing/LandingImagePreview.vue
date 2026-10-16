<script setup lang="ts">
import { withBase } from 'vitepress'
import { useTemplateRef } from 'vue'
import LandingIcon from './LandingIcon.vue'

defineProps<{
  src: string
  alt: string
  title: string
  enlarge: string
  close: string
  original: string
  width: number
  height: number
  mobilePosition?: string
  mobileSrc?: string
  mobileWidth?: number
  mobileHeight?: number
}>()
const preview = useTemplateRef<HTMLDialogElement>('preview')
function closeBackdrop(event: MouseEvent) {
  if (event.target === preview.value)
    preview.value?.close()
}
</script>

<template>
  <div class="image-preview" :class="{ 'has-mobile-detail': mobilePosition }" :style="{ '--mobile-position': mobilePosition }">
    <button class="preview-trigger" :aria-label="`${enlarge} · ${title}`" @click="preview?.showModal()">
      <picture>
        <source v-if="mobileSrc" media="(max-width: 760px)" :srcset="withBase(mobileSrc)" :width="mobileWidth" :height="mobileHeight">
        <img :src="withBase(src)" :alt="alt" :width="width" :height="height" loading="lazy">
      </picture>
      <span class="preview-hint"><LandingIcon name="expand" /><span>{{ enlarge }}</span></span>
    </button>
    <dialog ref="preview" class="preview-dialog" :aria-label="title" @click="closeBackdrop">
      <div class="dialog-toolbar">
        <span class="dialog-title">{{ title }}</span>
        <a :href="withBase(src)" target="_blank" rel="noreferrer">{{ original }}<LandingIcon name="external" /></a>
        <button class="dialog-close" :aria-label="close" autofocus @click="preview?.close()">
          <LandingIcon name="close" />
        </button>
      </div>
      <div class="dialog-image">
        <img :src="withBase(src)" :alt="alt" :width="width" :height="height">
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.image-preview { min-width: 0; }
.preview-trigger { position: relative; display: block; width: 100%; padding: 0; border: 0; overflow: hidden; cursor: zoom-in; background: var(--site-surface); }
.preview-trigger picture > img { display: block; width: 100%; height: auto; }
.preview-hint { position: absolute; right: 14px; bottom: 14px; display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #16285cf2; color: #fff4db; border: 1px solid #f2cc8060; font-size: 12px; opacity: 0; transition: opacity .18s; }
.preview-hint svg { width: 15px; height: 15px; }
.preview-trigger:hover .preview-hint, .preview-trigger:focus-visible .preview-hint { opacity: 1; }
.preview-dialog { padding: 0; border: 1px solid var(--site-line); border-radius: 5px; max-width: 96vw; width: max-content; max-height: 94dvh; margin: auto; background: var(--site-raised); color: var(--site-ink); overflow: auto; }
.preview-dialog::backdrop { background: #08142ce8; }
.dialog-toolbar { display: flex; align-items: center; justify-content: space-between; padding-left: 20px; font-size: 13px; gap: 20px; }
.dialog-title { flex: 1; }
.dialog-toolbar > a { display: flex; align-items: center; gap: 7px; min-height: 48px; color: var(--site-blue); white-space: nowrap; font-size: 12px; }
.dialog-toolbar > a svg { width: 14px; height: 14px; }
.dialog-image { overflow: auto; }
.dialog-image > img { display: block; width: auto; max-width: 96vw; max-height: calc(94dvh - 52px); object-fit: contain; }
.dialog-close { width: 48px; height: 48px; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; }
.dialog-close svg { width: 22px; height: 22px; }
.dialog-close:hover { color: var(--site-blue); }
@media (max-width: 760px) {
  .has-mobile-detail .preview-trigger picture > img { height: 320px; width: 100%; object-fit: none; object-position: var(--mobile-position); }
  .dialog-toolbar { padding-left: 14px; gap: 8px; } .dialog-title { display: none; } .dialog-toolbar > a { margin-right: auto; }
  .dialog-image > img { max-width: none; max-height: none; width: auto; height: auto; }
  .preview-dialog { width: 96vw; }
}
@media (hover: none) { .preview-hint { opacity: 1; padding: 8px; right: 8px; bottom: 8px; } .preview-hint span { display: none; } }
</style>
