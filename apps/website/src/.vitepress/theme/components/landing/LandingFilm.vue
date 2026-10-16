<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import { nextTick, shallowRef, useTemplateRef } from 'vue'
import LandingIcon from './LandingIcon.vue'
import { landingFilm } from './landingMedia'

defineProps<{ content: LandingContent['film'] }>()
const started = shallowRef(false)
const failed = shallowRef(false)
const player = useTemplateRef<HTMLVideoElement>('player')
async function play() {
  started.value = true
  await nextTick()
  player.value?.focus()
  try {
    await player.value?.play()
  }
  catch {
    failed.value = true
  }
}
</script>

<template>
  <section id="film" class="film-section" aria-labelledby="film-title">
    <div class="site-container">
      <div class="film-heading">
        <div>
          <p class="section-label">
            {{ content.label }}
          </p><h2 id="film-title">
            {{ content.title }}
          </h2>
        </div>
        <p class="film-description">
          {{ content.description }}
        </p>
      </div>
      <div class="film-stage">
        <video v-if="started && landingFilm.src" ref="player" :src="withBase(landingFilm.src)" :poster="withBase(landingFilm.poster)" controls playsinline preload="none" tabindex="0" :aria-label="content.play" @error="failed = true" />
        <template v-else>
          <img :src="withBase(landingFilm.poster)" alt="" width="1920" height="1080" loading="lazy">
          <button v-if="landingFilm.src" class="film-play" @click="play">
            <span class="play-symbol"><LandingIcon name="play" /></span><span>{{ content.play }}</span>
          </button>
          <span v-else class="film-pending">{{ content.unavailable }}</span>
        </template>
      </div>
      <div class="film-caption">
        <span>{{ content.caption }}</span><span v-if="content.language">{{ content.language }}</span>
      </div>
      <p v-if="failed" class="film-error">
        {{ content.error }} <a :href="withBase(landingFilm.src)" target="_blank" rel="noreferrer">{{ content.open }} ↗</a>
      </p>
    </div>
  </section>
</template>

<style scoped>
.film-section { padding: 78px 0 92px; background: var(--site-inset); }
.film-heading { display: grid; grid-template-columns: 1.3fr 1fr; align-items: end; gap: 72px; margin-bottom: 32px; }
.film-heading h2 { font-size: clamp(30px, 3vw, 42px); }
.film-description { max-width: 380px; font-size: 15px; line-height: 1.9; color: var(--site-muted); justify-self: end; }
.film-stage { position: relative; aspect-ratio: 16/9; overflow: hidden; background: var(--crew-deep); border: 1px solid #7185ae80; box-shadow: 0 18px 45px var(--site-shadow); }
.film-stage > img, .film-stage > video { width: 100%; height: 100%; display: block; object-fit: contain; }
.film-stage > img { opacity: .72; }
.film-play { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; color: #fff5de; cursor: pointer; font-size: 16px; font-weight: 600; background: #10225630; text-shadow: 0 1px 10px #081938; }
.play-symbol { display: grid; place-items: center; width: 80px; height: 80px; border-radius: 50%; background: var(--crew-gold); color: var(--crew-ink); box-shadow: 0 0 0 10px #f2cc8026; transition: transform .18s; }
.play-symbol svg { width: 31px; height: 31px; margin-left: 2px; }
.film-play:hover .play-symbol { transform: scale(1.06); }
.film-pending { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 15px 22px; background: var(--crew-gold); color: var(--crew-ink); white-space: nowrap; }
.film-caption { display: flex; justify-content: space-between; gap: 16px; margin-top: 16px; color: var(--site-muted); font-size: 11px; line-height: 1.7; }
.film-error { margin-top: 15px; font-size: 13px; } .film-error a { text-decoration: underline; }
@media (max-width: 760px) { .film-section { padding: 43px 0 50px; } .film-heading { grid-template-columns: 1fr; gap: 18px; margin-bottom: 24px; } .film-heading h2 { font-size: 28px; } .film-description { font-size: 13px; justify-self: start; } .play-symbol { width: 51px; height: 51px; box-shadow: 0 0 0 7px #f2cc8026; } .play-symbol svg { width: 22px; height: 22px; } .film-play { font-size: 12px; gap: 14px; } .film-caption { flex-direction: column; gap: 4px; font-size: 10px; } }
</style>
