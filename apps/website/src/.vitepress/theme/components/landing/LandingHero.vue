<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import { computed, shallowRef } from 'vue'
import { downloadUrl } from '../../../productLinks'
import LandingIcon from './LandingIcon.vue'
import { landingFilm } from './landingMedia'

const props = defineProps<{ content: LandingContent['hero'] }>()
const recruited = shallowRef(['explorer', 'executor', 'reviewer'])
const lastAction = shallowRef<{ id: string, added: boolean } | null>(null)
const status = computed(() => {
  const action = lastAction.value
  if (!action)
    return props.content.status
  const role = props.content.roles.find(role => role.id === action.id)
  return `${role?.name} · ${action.added ? props.content.added : props.content.removed}`
})
function toggleRole(id: string) {
  const added = !recruited.value.includes(id)
  recruited.value = added ? [...recruited.value, id] : recruited.value.filter(role => role !== id)
  lastAction.value = { id, added }
}
</script>

<template>
  <section id="crew" class="hero blue-world" aria-labelledby="hero-title">
    <div class="site-container">
      <div class="hero-title-row">
        <div class="title-block">
          <h1 id="hero-title">
            Lexora<span>.</span>
          </h1>
          <p class="product-type">
            {{ content.product }}
          </p>
        </div>
        <div class="hero-statement">
          <h2>{{ content.title }}</h2>
          <p>{{ content.description }}</p>
        </div>
        <div class="hero-actions">
          <a class="site-button gold-button" :href="downloadUrl" target="_blank" rel="noreferrer">{{ content.download }}<LandingIcon name="down" /></a>
          <span>{{ content.platforms }}</span>
          <a class="mobile-film-link" :href="landingFilm.src ? '#film' : '#workspace'">{{ landingFilm.src ? content.watch : content.explore }}<LandingIcon :name="landingFilm.src ? 'play' : 'down'" /></a>
        </div>
      </div>
      <div class="recruitment-table">
        <article class="lead-dossier">
          <img class="lead-portrait" :src="withBase('/landing/lexora-avatar.webp')" :alt="content.leadAlt" width="1254" height="1254" fetchpriority="high">
          <div class="lead-copy">
            <div class="lead-name">
              <h3>Lexora</h3>
            </div>
            <p>{{ content.leadDescription }}</p>
          </div>
        </article>
        <div class="companions-area">
          <div class="companions-heading">
            <h3>{{ content.companionsTitle }}</h3>
            <p>{{ content.companionsDescription }}</p>
          </div>
          <div class="companion-grid">
            <article v-for="companion in content.companions" :key="companion.id" class="companion-card">
              <img :src="withBase(`/landing/companions/${companion.id}.webp`)" :alt="companion.alt" width="512" height="512">
              <div class="companion-name">
                <h4>{{ companion.name }}</h4><p>{{ companion.model }}</p>
              </div>
            </article>
          </div>
          <p class="customization">
            {{ content.customization }}
          </p>
        </div>
        <div class="support-area">
          <div class="support-heading">
            <h3>{{ content.team }}</h3>
            <p>{{ content.teamDescription }}</p>
          </div>
          <div class="support-grid">
            <button v-for="role in content.roles" :key="role.id" class="support-member" :aria-pressed="recruited.includes(role.id)" :aria-label="`${role.name} · ${recruited.includes(role.id) ? content.remove : content.recruit}`" @click="toggleRole(role.id)">
              <img :src="withBase(`/landing/crew/${role.id}.webp`)" alt="" width="512" height="512">
              <span class="support-copy"><strong>{{ role.name }}</strong><span>{{ role.description }}</span></span>
              <LandingIcon :name="recruited.includes(role.id) ? 'check' : 'plus'" />
            </button>
          </div>
          <div class="support-caption">
            <span>{{ recruited.length }} / {{ content.roles.length }} {{ content.recruited }}</span><span>{{ content.demo }}</span>
          </div>
        </div>
      </div>
      <div class="hero-footnote">
        <p aria-live="polite">
          <span class="status-dot" aria-hidden="true" />{{ status }}
        </p>
        <a :href="landingFilm.src ? '#film' : '#workspace'">{{ landingFilm.src ? content.watch : content.explore }}<LandingIcon :name="landingFilm.src ? 'play' : 'down'" /></a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero { padding: 44px 0 24px; }
.hero-title-row { display: grid; grid-template-columns: 1fr 1.45fr auto; gap: 48px; align-items: center; margin-bottom: 52px; }
h1 { font: 700 clamp(72px, 7vw, 96px)/.95 var(--site-display); letter-spacing: -.04em; color: var(--crew-gold); }
h1 span { color: var(--crew-paper); }
.product-type { margin-top: 16px; font-size: 15px; letter-spacing: .015em; color: var(--crew-light); }
.hero-statement h2 { font-size: clamp(27px, 2.6vw, 36px); line-height: 1.32; font-weight: 650; letter-spacing: -.03em; color: var(--crew-paper); }
.hero-statement > p { margin-top: 12px; font-size: 14px; line-height: 1.9; white-space: pre-line; color: var(--crew-light); }
.hero-actions { display: flex; flex-direction: column; gap: 14px; align-items: center; }
.hero-actions > span { font-size: 11px; color: var(--crew-light); }
.mobile-film-link { display: none; }
.recruitment-table { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); column-gap: 64px; row-gap: 24px; align-items: start; }
.lead-dossier { grid-row: span 2; align-self: start; padding: 14px; transform: rotate(-3deg); background: var(--crew-paper); color: var(--crew-ink); box-shadow: 4px 12px 24px #12245738; }
.lead-portrait { width: 100%; height: auto; display: block; }
.lead-copy { padding: 0 4px 8px; }
.lead-name { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 20px 0 12px; }
.lead-name h3 { font: 700 38px/1 var(--site-display); letter-spacing: -.04em; }
.lead-name span { font-size: 12px; color: #526078; }
.lead-copy > p { font-size: 13px; line-height: 1.8; white-space: pre-line; }
.companions-area { max-width: 744px; }
.companions-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 20px; margin-bottom: 20px; }
.companions-heading h3 { font-size: 20px; line-height: 1.5; font-weight: 600; }
.companions-heading p { font-size: 12px; color: var(--crew-light); }
.companion-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; max-width: 744px; }
.companion-card { min-width: 0; padding: 10px; background: var(--crew-paper); color: var(--crew-ink); }
.companion-card:nth-child(2) { transform: translateY(8px) rotate(1deg); }
.companion-card > img { display: block; width: 100%; height: auto; aspect-ratio: 1; }
.companion-name { padding: 12px 4px 4px; }
.companion-name h4 { margin: 0 0 4px; font-size: 24px; font-weight: 650; line-height: 1.35; }
.companion-name p { font: 500 12px/1.5 var(--site-display); color: #526078; }
.customization { margin-top: 24px; color: var(--crew-light); font-size: 12px; line-height: 1.8; }
.support-area { grid-column: 2; max-width: 744px; padding-top: 20px; border-top: 1px solid #6983b375; }
.support-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin-bottom: 16px; }
.support-heading h3 { font-size: 14px; font-weight: 600; color: var(--crew-paper); }
.support-heading p { font-size: 11px; color: var(--crew-light); }
.support-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.support-member { position: relative; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; text-align: left; min-width: 0; padding: 8px; border: 1px solid #7188ba; border-radius: 4px; background: transparent; color: var(--crew-paper); cursor: pointer; transition: background .18s; }
.support-member:hover { background: #ffffff12; }
.support-member[aria-pressed="true"] { border-color: #9eafcf; }
.support-member img { width: 44px; height: 44px; object-fit: cover; border-radius: 50%; }
.support-copy { display: block; width: 100%; }
.support-copy strong { display: block; font-size: 13px; font-weight: 500; line-height: 1.5; }
.support-copy > span { display: block; margin-top: 4px; white-space: pre-line; font-size: 10px; line-height: 1.7; color: var(--crew-light); }
.support-member > svg { position: absolute; right: 8px; top: 12px; width: 14px; height: 14px; color: var(--crew-gold); }
.support-caption { display: flex; justify-content: space-between; gap: 12px; margin-top: 12px; font-size: 10px; line-height: 1.6; color: var(--crew-light); }
.hero-footnote { border-top: 1px solid #6983b375; margin-top: 32px; padding-top: 12px; display: flex; justify-content: space-between; align-items: center; gap: 24px; font-size: 12px; color: var(--crew-light); }
.hero-footnote > p { display: flex; gap: 10px; align-items: center; }
.status-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--crew-gold); flex-shrink: 0; }
.hero-footnote > a { display: flex; align-items: center; gap: 15px; min-height: 44px; color: var(--crew-gold); font-weight: 600; }
.hero-footnote svg { width: 17px; height: 17px; }
@media (min-width: 1380px) { .support-member { flex-wrap: nowrap; padding-right: 24px; } .support-copy { width: auto; } .support-copy > span { font-size: 10px; } }
@media (max-width: 1200px) { .hero-title-row { gap: 28px; } .recruitment-table { grid-template-columns: 260px minmax(0, 1fr); column-gap: 44px; } .companion-grid { gap: 16px; } .companion-name h4 { font-size: 22px; } }
@media (max-width: 960px) and (min-width: 761px) { .hero-title-row { grid-template-columns: 1fr 1.4fr; margin-bottom: 36px; } .hero-actions { grid-column: 1 / -1; flex-direction: row; justify-content: flex-start; } .recruitment-table { grid-template-columns: 220px minmax(0, 1fr); column-gap: 32px; row-gap: 24px; } .lead-name { flex-wrap: wrap; } .lead-name h3 { font-size: 32px; } .companion-grid { gap: 12px; } .companion-card { padding: 8px; } .companion-name { padding: 10px 0 2px; } .companion-name h4 { font-size: 20px; } .support-area { grid-column: 1 / -1; } .support-member { flex-wrap: nowrap; padding-right: 24px; } .support-copy { width: auto; } .support-copy > span { white-space: normal; } }
@media (max-width: 760px) {
  .hero { padding: 24px 0 16px; }
  .hero-title-row { grid-template-columns: 1fr; gap: 16px; margin-bottom: 32px; }
  h1 { font-size: 64px; } .product-type { font-size: 12px; margin-top: 12px; }
  .hero-statement h2 { font-size: 28px; white-space: pre-line; } .hero-statement > p { font-size: 13px; margin-top: 8px; white-space: normal; max-width: 420px; line-height: 1.8; }
  .hero-actions { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; justify-items: start; align-items: center; }
  .hero-actions .site-button { grid-row: 1 / 3; min-height: 48px; padding-inline: 16px; gap: 12px; }
  .hero-actions > span { font-size: 9px; }
  .mobile-film-link { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--crew-gold); min-height: 28px; }
  .mobile-film-link svg { width: 13px; height: 13px; }
  .recruitment-table { grid-template-columns: 1fr; gap: 28px; }
  .lead-dossier { grid-row: auto; display: grid; grid-template-columns: minmax(0, .95fr) minmax(0, 1fr); align-items: center; gap: 16px; padding: 12px; transform: rotate(-2deg); }
  .lead-copy { padding: 4px 0; }
  .lead-name { align-items: flex-start; flex-direction: column; margin: 0 0 12px; gap: 8px; }
  .lead-name h3 { font-size: 36px; } .lead-name span { font-size: 11px; } .lead-copy > p { font-size: 11px; white-space: normal; }
  .companions-heading { gap: 4px; margin-bottom: 16px; } .companions-heading h3 { font-size: 17px; } .companions-heading p { width: 100%; font-size: 11px; }
  .companion-grid { gap: 12px; max-width: none; }
  .companion-card { padding: 6px; } .companion-card:nth-child(2) { transform: translateY(4px); }
  .companion-name { padding: 8px 2px 4px; } .companion-name h4 { font-size: 18px; } .companion-name p { font-size: 10px; }
  .customization { margin-top: 16px; font-size: 11px; }
  .support-area { grid-column: 1; padding-top: 16px; }
  .support-heading { gap: 4px; } .support-heading p { width: 100%; }
  .support-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .support-member { flex-wrap: nowrap; padding: 8px 20px 8px 8px; }
  .support-member img { width: 32px; height: 32px; }
  .support-copy { width: auto; } .support-copy strong { font-size: 12px; } .support-copy > span { display: none; }
  .support-member > svg { width: 12px; height: 12px; right: 6px; top: 8px; }
  .hero-footnote { margin-top: 24px; padding-top: 16px; font-size: 10px; } .hero-footnote > a { display: none; }
}
</style>
