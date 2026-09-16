<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { computed, nextTick, shallowRef } from 'vue'
import LandingDesktopDemo from './LandingDesktopDemo.vue'
import LandingIcon from './LandingIcon.vue'

const props = defineProps<{ content: LandingContent['demo'] }>()
const selected = shallowRef(0)
const scenario = computed(() => props.content.scenarios[selected.value]!)

async function moveTab(event: KeyboardEvent) {
  const count = props.content.scenarios.length
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key))
    return
  event.preventDefault()
  if (event.key === 'Home')
    selected.value = 0
  else if (event.key === 'End')
    selected.value = count - 1
  else
    selected.value = (selected.value + (event.key === 'ArrowRight' ? 1 : -1) + count) % count
  await nextTick()
  const tabList = (event.target as HTMLElement).closest('[role="tablist"]')
  tabList?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
}
</script>

<template>
  <section id="playground" class="playground site-section site-container" aria-labelledby="playground-title">
    <div class="section-intro">
      <div>
        <p class="eyebrow">
          {{ content.eyebrow }}
        </p>
        <h2 id="playground-title">
          {{ content.title }}
        </h2>
      </div>
      <p class="section-description">
        {{ content.description }}
      </p>
    </div>
    <div class="scenario-tabs" role="tablist" :aria-label="content.label" @keydown="moveTab">
      <button v-for="(item, index) in content.scenarios" :id="`tab-${item.id}`" :key="item.id" role="tab" :aria-selected="selected === index" :tabindex="selected === index ? 0 : -1" aria-controls="scenario-panel" @click="selected = index">
        <LandingIcon :name="item.icon" />{{ item.name }}<span class="tab-dot" />
      </button>
    </div>
    <div id="scenario-panel" role="tabpanel" :aria-labelledby="`tab-${scenario.id}`" tabindex="0">
      <LandingDesktopDemo :key="scenario.id" :content="content" :scenario="scenario" @select="selected = $event" />
    </div>
    <p class="example-note">
      {{ content.exampleNote }}
    </p>
  </section>
</template>

<style scoped>
.section-intro { display: flex; align-items: flex-end; justify-content: space-between; gap: 48px; margin-bottom: 40px; }
.section-description { max-width: 390px; white-space: pre-line; color: var(--site-muted); font-size: 14px; line-height: 2; }
.scenario-tabs { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
.scenario-tabs button { display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 0 19px; border: 1px solid transparent; border-radius: 7px; font-size: 13px; color: var(--site-muted); transition: background .2s, color .2s, border-color .2s; cursor: pointer; }
.scenario-tabs button > svg { width: 17px; height: 17px; }
.scenario-tabs button:hover { color: var(--site-ink); background: var(--site-accent-soft); }
.scenario-tabs button[aria-selected='true'] { background: var(--site-accent-soft); color: var(--site-gold); border-color: var(--site-line); }
.tab-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: 0; margin-left: 9px; }
[aria-selected='true'] .tab-dot { opacity: 1; }
.example-note { margin-top: 18px; font-size: 10px; color: var(--site-faint); text-align: center; line-height: 1.8; }
@media (max-width: 760px) {
  .section-intro { display: block; margin-bottom: 28px; }
  .section-description { margin-top: 22px; max-width: none; font-size: 13px; }
  .scenario-tabs { gap: 6px; }
  .scenario-tabs button { padding: 0 12px; gap: 7px; font-size: 11px; }
  .tab-dot { display: none; }
  .example-note { font-size: 9px; }
}
</style>
