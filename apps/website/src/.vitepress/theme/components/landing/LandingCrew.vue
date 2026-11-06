<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { withBase } from 'vitepress'
import { computed, shallowRef } from 'vue'
import LandingIcon from './LandingIcon.vue'

const props = defineProps<{ content: LandingContent['crew'], english: boolean }>()
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
  <section id="crew" class="crew blue-world" aria-labelledby="crew-title">
    <div class="site-container">
      <div class="crew-heading">
        <h2 id="crew-title">
          {{ content.title }}
        </h2>
        <p>{{ content.description }}</p>
      </div>
      <div class="recruitment-table">
        <article class="lead-dossier">
          <img class="lead-portrait" :src="withBase('/landing/lexora-avatar.webp')" :alt="content.leadAlt" width="1254" height="1254" loading="lazy">
          <h3>Lexora</h3>
          <p>{{ content.leadDescription }}</p>
        </article>
        <div class="companions-area">
          <h3>{{ content.companionsTitle }}</h3>
          <p class="companions-description">
            {{ content.companionsDescription }}
          </p>
          <div class="companion-grid">
            <article v-for="companion in content.companions" :key="companion.id" class="companion-card">
              <img :src="withBase(`/landing/companions/${companion.id}.webp`)" :alt="companion.alt" width="512" height="512" loading="lazy">
              <h4>{{ companion.name }}</h4><p>{{ companion.model }}</p>
            </article>
          </div>
          <p class="customization">
            {{ content.customization }}
          </p>
        </div>
      </div>
      <div class="support-area">
        <div class="support-heading">
          <h3>{{ content.team }}</h3>
          <p>{{ content.teamDescription }}</p>
        </div>
        <div class="support-grid">
          <button v-for="role in content.roles" :key="role.id" class="support-member" :aria-pressed="recruited.includes(role.id)" :aria-label="`${role.name} · ${recruited.includes(role.id) ? content.remove : content.recruit}`" @click="toggleRole(role.id)">
            <img :src="withBase(`/landing/crew/${role.id}.webp`)" alt="" width="512" height="512" loading="lazy">
            <span class="support-copy"><strong>{{ role.name }}</strong><span>{{ role.description }}</span></span>
            <LandingIcon :name="recruited.includes(role.id) ? 'check' : 'plus'" />
          </button>
        </div>
        <div class="support-caption">
          <span>{{ recruited.length }} / {{ content.roles.length }} {{ content.recruited }}</span><span>{{ content.demo }}</span>
        </div>
      </div>
      <div class="crew-footnote">
        <p aria-live="polite">
          {{ status }}
        </p>
        <a :href="withBase(`${english ? '/en' : ''}/guide/companions`)">{{ content.guide }}<LandingIcon name="arrow" /></a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.crew { padding: 72px 0 40px; margin-bottom: 88px; }
.crew-heading { display: grid; grid-template-columns: 1fr 1fr; gap: 64px; align-items: end; margin-bottom: 44px; }
.crew-heading p { font-size: 16px; line-height: 1.9; color: var(--crew-light); }
.recruitment-table { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 64px; align-items: center; }
.lead-dossier { text-align: center; }
.lead-portrait { width: 200px; height: 200px; margin-inline: auto; object-fit: contain; }
.lead-dossier h3 { font: 600 32px/1.4 var(--site-display); color: var(--crew-gold); margin-top: 16px; }
.lead-dossier p { font-size: 14px; line-height: 1.8; color: var(--crew-light); white-space: pre-line; margin-top: 8px; }
.companions-area h3, .support-heading h3 { font-size: 21px; line-height: 1.5; }
.companions-description { color: var(--crew-light); margin-top: 8px; font-size: 15px; }
.companion-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin-top: 24px; }
.companion-card { text-align: center; }
.companion-card img { width: 128px; max-width: 100%; height: auto; margin-inline: auto; }
.companion-card h4 { margin: 12px 0 4px; font-size: 19px; }
.companion-card p { font-size: 13px; color: var(--crew-light); }
.customization { margin-top: 24px; font-size: 13px; line-height: 1.8; color: var(--crew-light); }
.support-area { border-top: 1px solid #7890c57a; padding-top: 32px; margin-top: 36px; }
.support-heading p { color: var(--crew-light); font-size: 15px; line-height: 1.8; margin-top: 8px; }
.support-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 24px; }
.support-member { display: flex; align-items: center; gap: 12px; min-height: 104px; padding: 12px; border: 1px solid #7890c57a; border-radius: 6px; background: var(--crew-deep); color: var(--crew-paper); cursor: pointer; text-align: left; }
.support-member[aria-pressed="true"] { border-color: var(--crew-gold); }
.support-member:hover { background: #21396b; }
.support-member img { width: 52px; height: 52px; object-fit: contain; flex-shrink: 0; }
.support-member > svg { width: 18px; flex-shrink: 0; margin-left: auto; color: var(--crew-gold); }
.support-copy { display: flex; flex-direction: column; gap: 6px; }
.support-copy strong { font-size: 15px; font-weight: 500; }
.support-copy > span { font-size: 12px; line-height: 1.6; color: var(--crew-light); }
.support-caption, .crew-footnote { display: flex; justify-content: space-between; gap: 16px; color: var(--crew-light); font-size: 13px; line-height: 1.8; }
.support-caption { margin-top: 14px; }
.crew-footnote { margin-top: 24px; align-items: center; }
.crew-footnote a { display: flex; align-items: center; gap: 12px; min-height: 44px; color: var(--crew-gold); }
.crew-footnote a:hover { text-decoration: underline; }
.crew-footnote svg { width: 18px; }
@media (max-width: 1100px) { .support-grid { grid-template-columns: 1fr 1fr; } .recruitment-table, .crew-heading { gap: 32px; } }
@media (max-width: 760px) {
  .crew { padding: 44px 0 28px; margin-bottom: 56px; }
  .crew-heading { grid-template-columns: 1fr; gap: 20px; }
  .crew-heading p { font-size: 15px; }
  .recruitment-table { grid-template-columns: 1fr; gap: 32px; }
  .lead-portrait { width: 150px; height: 150px; }
  .companion-grid { gap: 12px; }
  .companion-card h4 { font-size: 17px; }
  .support-grid { grid-template-columns: 1fr; }
  .support-member { min-height: 88px; }
  .support-caption, .crew-footnote { flex-direction: column; align-items: flex-start; gap: 8px; }
}
</style>
