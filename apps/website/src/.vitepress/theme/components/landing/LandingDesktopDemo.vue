<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { shallowRef, useTemplateRef } from 'vue'
import LandingDemoTask from './LandingDemoTask.vue'
import LandingIcon from './LandingIcon.vue'

defineProps<{ content: LandingContent['demo'], scenario: LandingContent['demo']['scenarios'][number] }>()
defineEmits<{ select: [index: number] }>()
const fileVisible = shallowRef(false)
const fileDialog = useTemplateRef<HTMLDialogElement>('fileDialog')

function openArtifact() {
  fileVisible.value = true
  fileDialog.value?.showModal()
}
</script>

<template>
  <div class="desktop-demo">
    <aside class="demo-sidebar" :aria-label="content.task">
      <div class="demo-brand">
        <LandingIcon /><strong>Lexora</strong>
      </div>
      <span class="sidebar-heading">{{ content.task }}</span>
      <button v-for="(item, index) in content.scenarios" :key="item.id" :aria-pressed="item.id === scenario.id" @click="$emit('select', index)">
        <LandingIcon :name="item.icon" /><span>{{ item.name }}</span>
      </button>
      <div class="sidebar-spaces">
        <span class="sidebar-heading">{{ content.spaces }}</span><p><LandingIcon name="folder" />{{ content.workspace }}</p><p><LandingIcon name="folder" />{{ content.sandbox }}</p>
      </div>
      <a class="real-app-link" href="#product">{{ content.realApp }}<LandingIcon name="arrow" /></a>
    </aside>
    <div class="demo-main">
      <div class="demo-titlebar">
        <span>{{ scenario.name }}</span><span class="simulation-badge">{{ content.label }}</span>
      </div>
      <LandingDemoTask :key="scenario.id" :content="content" :scenario="scenario" @open-artifact="openArtifact" />
    </div>
    <dialog ref="fileDialog" class="demo-file-dialog" :aria-label="content.preview" @close="fileVisible = false" @click="event => { if (event.target === fileDialog) fileDialog?.close() }">
      <div class="file-toolbar">
        <span><LandingIcon name="file" />{{ scenario.file }}</span><button :aria-label="content.closeFile" @click="fileDialog?.close()">
          <LandingIcon name="close" />
        </button>
      </div>
      <article v-if="fileVisible" class="output-paper">
        <p class="paper-label">
          LEXORA / {{ content.preview }}
        </p>
        <h3>{{ scenario.resultTitle }}</h3>
        <p class="paper-summary">
          {{ scenario.summary }}
        </p>
        <h4>{{ content.highlights }}</h4>
        <ul>
          <li v-for="line in scenario.lines" :key="line">
            {{ line }}
          </li>
        </ul>
        <footer>{{ content.exampleNote }}</footer>
      </article>
    </dialog>
  </div>
</template>

<style scoped>
.desktop-demo { --demo-bg: #fffefa; --demo-soft: #f6f5f0; --demo-ink: #303a3d; --demo-muted: #737d80; --demo-line: #dfe3df; --demo-accent: #52766b; display: grid; grid-template-columns: 205px minmax(0, 1fr); background: var(--demo-bg); color: var(--demo-ink); border: 1px solid var(--demo-line); border-radius: 14px; overflow: hidden; box-shadow: 0 25px 70px var(--site-shadow); }
.desktop-demo :focus-visible { outline-color: var(--demo-accent); }
.demo-sidebar { padding: 26px 15px 20px; background: #eeefeb; border-right: 1px solid var(--demo-line); display: flex; flex-direction: column; }
.demo-brand { display: flex; align-items: center; gap: 9px; font-family: var(--site-display); font-size: 25px; letter-spacing: -1px; padding: 0 10px; margin-bottom: 39px; }
.demo-brand svg { width: 24px; color: var(--demo-accent); }
.sidebar-heading { display: block; font-size: 10px; color: var(--demo-muted); padding-inline: 12px; margin-bottom: 12px; }
.demo-sidebar > button { display: flex; align-items: center; gap: 11px; min-height: 43px; padding: 9px 12px; margin-bottom: 4px; border: 1px solid transparent; border-radius: 6px; text-align: left; cursor: pointer; font-size: 12px; }
.demo-sidebar > button svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--demo-muted); }
.demo-sidebar > button[aria-pressed='true'] { background: #dfe7e1; border-color: #cfdbd3; color: #345f4d; }
.demo-sidebar > button:hover { background: #e3e7e1; }
.sidebar-spaces { margin-top: 35px; }
.sidebar-spaces p { display: flex; align-items: center; gap: 10px; padding: 10px 12px; font-size: 11px; color: var(--demo-muted); }
.sidebar-spaces svg { width: 16px; height: 16px; }
.real-app-link { margin-top: auto; padding: 30px 12px 0; display: flex; align-items: center; gap: 9px; font-size: 10px; color: var(--demo-accent); }
.real-app-link svg { width: 14px; }
.demo-main { min-width: 0; }
.demo-titlebar { min-height: 58px; padding: 14px 28px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--demo-line); font-size: 12px; font-weight: 600; }
.simulation-badge { font-size: 9px; font-weight: 400; color: var(--demo-muted); border: 1px solid var(--demo-line); border-radius: 20px; padding: 3px 9px; }
.demo-file-dialog { width: min(640px, calc(100vw - 32px)); max-height: 85vh; margin: auto; padding: 0; border: 1px solid var(--demo-line); border-radius: 12px; background: var(--demo-bg); color: var(--demo-ink); overflow: auto; }
.demo-file-dialog::backdrop { background: #111724bb; backdrop-filter: blur(6px); }
.file-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 7px 12px 7px 22px; background: var(--demo-soft); border-bottom: 1px solid var(--demo-line); }
.file-toolbar > span { display: flex; align-items: center; gap: 8px; font-size: 12px; overflow-wrap: anywhere; }
.file-toolbar svg { width: 16px; height: 16px; flex-shrink: 0; }
.file-toolbar button { width: 44px; height: 44px; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; }
.output-paper { padding: 38px 42px; }
.paper-label { font-family: var(--site-mono); font-size: 9px; color: var(--demo-accent); letter-spacing: 1px; }
.output-paper h3 { margin-top: 20px; font-size: 28px; line-height: 1.5; }
.paper-summary { margin-top: 18px; font-size: 14px; line-height: 2; color: var(--demo-muted); }
.output-paper h4 { margin: 28px 0 14px; font-size: 14px; }
.output-paper ul { padding-left: 20px; list-style: disc; display: grid; gap: 15px; font-size: 13px; line-height: 1.9; }
.output-paper footer { margin-top: 38px; border-top: 1px solid var(--demo-line); padding-top: 18px; font-size: 10px; line-height: 1.8; color: var(--demo-muted); }
@media (max-width: 760px) {
  .desktop-demo { grid-template-columns: minmax(0, 1fr); border-radius: 10px; }
  .demo-sidebar { display: none; }
  .demo-titlebar { padding: 12px 18px; min-height: 50px; }
  .output-paper { padding: 26px 24px; }
  .output-paper h3 { font-size: 23px; }
}
</style>
