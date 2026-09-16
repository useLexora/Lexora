<script setup lang="ts">
import type { LandingContent } from './landingContent'
import LandingIcon from './LandingIcon.vue'

defineProps<{ content: LandingContent['capabilities'] }>()
</script>

<template>
  <section id="capabilities" class="capabilities site-section site-container" aria-labelledby="capabilities-title">
    <p class="eyebrow">
      {{ content.eyebrow }}
    </p><h2 id="capabilities-title">
      {{ content.title }}
    </h2>
    <div class="capabilities-grid">
      <article class="capability local-card">
        <div class="capability-copy">
          <p class="card-label">
            {{ content.local.label }}
          </p><h3>{{ content.local.title }}</h3><p>{{ content.local.description }}</p>
        </div>
        <div class="folder-illustration" aria-hidden="true">
          <div class="folder-back">
            <span />
          </div>
          <div class="folder-paper">
            <i /><i /><i />
          </div>
          <div class="folder-front">
            <LandingIcon name="folder" /><span>{{ content.local.folder }}</span><span>↗</span>
          </div>
          <div class="file-stack">
            <div v-for="(file, index) in content.local.files" :key="file">
              <LandingIcon :name="index === 2 ? 'spark' : 'file'" />{{ file }}<span>0{{ index + 1 }}</span>
            </div>
          </div>
          <span class="local-badge"><i />ON YOUR COMPUTER</span>
        </div>
      </article>
      <article class="capability extensions-card">
        <div class="capability-copy">
          <p class="card-label">
            {{ content.extensions.label }}
          </p><h3>{{ content.extensions.title }}</h3><p>{{ content.extensions.description }}</p>
        </div>
        <div class="tool-constellation" aria-hidden="true">
          <div class="constellation-orbit" /><div class="constellation-line" />
          <div class="tool-node model-node">
            Models<span>✳</span>
          </div>
          <div class="tool-node skill-node">
            Skills<span>✧</span>
          </div>
          <div class="tool-node mcp-node">
            MCP<span>⌘</span>
          </div>
          <div class="tool-core">
            <LandingIcon /><span>{{ content.extensions.core }}</span>
          </div>
        </div>
      </article>
      <article class="capability automation-card">
        <div class="capability-copy">
          <p class="card-label">
            {{ content.automation.label }}
          </p><h3>{{ content.automation.title }}</h3><p>{{ content.automation.description }}</p>
        </div>
        <div class="schedule-illustration" aria-hidden="true">
          <div class="schedule-header">
            <LandingIcon name="clock" /><span>{{ content.automation.time }}</span><span class="schedule-indicator" />
          </div>
          <div class="week">
            <span v-for="(day, index) in content.automation.days" :key="index" :class="{ 'is-friday': index === 4 }">{{ day }}</span>
          </div>
          <div class="scheduled-task">
            <span>↻</span>{{ content.automation.task }}<LandingIcon name="check" />
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.capabilities-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 22px; margin-top: 40px; }
.capability { overflow: hidden; position: relative; background: var(--site-surface); border: 1px solid var(--site-line); border-radius: 13px; }
.capability-copy { position: relative; z-index: 1; padding: 34px 34px 0; }
.card-label { font-family: var(--site-mono); color: var(--site-gold); letter-spacing: 1.5px; font-size: 9px; }
h3 { white-space: pre-line; margin-top: 18px; font-size: 28px; line-height: 1.5; letter-spacing: -.8px; font-weight: 550; }
.capability-copy > p:last-child { font-size: 13px; color: var(--site-muted); line-height: 1.9; max-width: 400px; margin-top: 16px; }
.local-card { grid-row: span 2; background: radial-gradient(ellipse at 50% 80%, #78948213, transparent 65%), var(--site-surface); }
.folder-illustration { position: relative; height: 360px; margin-top: 65px; margin-inline: 30px; }
.folder-back { position: absolute; left: 13%; right: 10%; height: 175px; top: 35px; border: 1px solid #a6c7b14a; border-radius: 10px; background: #2a3c3b; transform: rotate(-7deg); }
.folder-back > span { position: absolute; top: -18px; left: -1px; width: 40%; height: 24px; border: 1px solid #a6c7b14a; border-bottom: none; border-radius: 10px 16px 0 0; background: #2a3c3b; }
.folder-paper { position: absolute; left: 17%; top: 30px; right: 15%; height: 158px; background: #b9c9b2; border-radius: 4px; transform: rotate(3deg); padding: 30px; }
.folder-paper i { display: block; margin-bottom: 12px; height: 4px; background: #32454424; width: 72%; }
.folder-paper i:nth-child(2) { width: 90%; }
.folder-front { position: absolute; left: 13%; right: 10%; height: 148px; top: 82px; background: linear-gradient(135deg, #344d48, #283c3a); border: 1px solid #a6c7b155; border-radius: 10px; transform: rotate(-7deg); display: flex; align-items: center; gap: 12px; padding-inline: 28px; color: #c6d8c8; font-size: 13px; box-shadow: 0 30px 30px #0002; }
.folder-front > svg { width: 24px; }
.folder-front > span:last-child { margin-left: auto; color: #9fc5a9; font-size: 22px; }
.file-stack { position: absolute; left: 22%; top: 198px; right: 0; padding: 8px 15px; border: 1px solid #71878755; background: #202c32f5; border-radius: 9px; transform: rotate(3deg); box-shadow: 0 20px 30px #0003; }
.file-stack > div { display: flex; align-items: center; gap: 10px; font-size: 11px; color: #bccac5; padding: 12px 0; border-bottom: 1px solid #a0c9b112; }
.file-stack > div:last-child { border: 0; }
.file-stack svg { width: 15px; height: 15px; color: #9ec7b0; }
.file-stack span { margin-left: auto; font-family: var(--site-mono); font-size: 8px; color: #93a6a1; }
.local-badge { position: absolute; bottom: 0; left: 5%; font-size: 8px; font-family: var(--site-mono); letter-spacing: 1.6px; color: var(--site-faint); display: flex; gap: 7px; align-items: center; transform: rotate(-90deg); transform-origin: left; }
.local-badge i { height: 4px; width: 4px; background: var(--site-mint); border-radius: 50%; }
.extensions-card { min-height: 330px; }
.extensions-card .capability-copy { padding-right: 37%; padding-bottom: 30px; }
.extensions-card h3, .automation-card h3 { font-size: 23px; }
.extensions-card .capability-copy > p:last-child { font-size: 12px; }
.tool-constellation { position: absolute; width: 170px; height: 240px; right: 12px; top: 61px; transform: rotate(-9deg); }
.constellation-orbit { position: absolute; inset: 5px 2px; border: 1px dashed #c9b98d3b; border-radius: 50%; }
.constellation-line { position: absolute; height: 1px; width: 200px; background: #c9b98d2a; left: -13px; top: 120px; transform: rotate(60deg); }
.tool-node { position: absolute; display: flex; gap: 16px; align-items: center; padding: 11px 13px; border: 1px solid #b8a77a40; border-radius: 7px; color: var(--site-gold); font-family: var(--site-mono); font-size: 11px; background: var(--site-raised); box-shadow: 0 12px 20px #0002; }
.model-node { left: 5px; top: 0; }
.skill-node { left: -22px; bottom: 14px; }
.mcp-node { left: 65px; top: 110px; }
.tool-node > span { font-size: 19px; }
.tool-core { position: absolute; top: 88px; left: 7px; color: var(--site-gold); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.tool-core > svg { width: 31px; height: 31px; }
.tool-core > span { font-size: 8px; color: var(--site-muted); }
.automation-card { padding-bottom: 28px; }
.automation-card .capability-copy { padding-top: 28px; }
.automation-card .card-label { color: var(--site-blue); }
.automation-card h3 { white-space: normal; }
.automation-card .capability-copy > p:last-child { font-size: 12px; margin-top: 12px; }
.schedule-illustration { border: 1px solid #9faecc26; border-radius: 8px; background: var(--site-inset); margin: 24px 34px 0; padding: 18px; }
.schedule-header { display: flex; align-items: center; gap: 8px; color: var(--site-blue); font-size: 10px; }
.schedule-header > svg { width: 14px; height: 14px; }
.schedule-indicator { width: 5px; height: 5px; border-radius: 50%; background: var(--site-mint); margin-left: auto; }
.week { margin-top: 15px; display: flex; justify-content: space-between; color: var(--site-faint); font-size: 9px; }
.week > span { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 50%; }
.week .is-friday { color: var(--site-bg); background: var(--site-blue); }
.scheduled-task { display: flex; align-items: center; gap: 9px; margin-top: 15px; padding-top: 15px; border-top: 1px solid var(--site-line); font-size: 10px; color: var(--site-muted); }
.scheduled-task > span { font-size: 18px; color: var(--site-blue); }
.scheduled-task > svg { margin-left: auto; width: 13px; height: 13px; color: var(--site-mint); }
@media (max-width: 900px) { .capabilities-grid { grid-template-columns: 1fr 1fr; } .capability-copy { padding: 28px 25px 0; } .extensions-card .capability-copy { padding-right: 25px; } .tool-constellation { opacity: .12; right: -80px; z-index: 0; } .folder-illustration { margin-inline: 5px; } .folder-front { padding-inline: 20px; } .schedule-illustration { margin-inline: 25px; } .folder-illustration { margin-top: 90px; } }
@media (max-width: 760px) {
  .capabilities-grid { grid-template-columns: 1fr; gap: 18px; margin-top: 30px; }
  .local-card { grid-row: auto; }
  .capability-copy { padding: 28px 27px 0; }
  h3 { font-size: 25px; }
  .folder-illustration { height: 370px; max-width: 400px; margin: 35px auto 15px; width: 90%; }
  .extensions-card { min-height: 325px; }
  .extensions-card .capability-copy { padding: 28px 27px 0; }
  .tool-constellation { position: relative; opacity: 1; right: auto; top: auto; width: 230px; height: 180px; margin: 30px auto; transform: none; }
  .model-node { left: 0; }
  .skill-node { left: 0; bottom: 0; }
  .mcp-node { left: auto; right: 0; top: 73px; }
  .tool-core { left: 84px; top: 61px; }
  .tool-core > span { display: none; }
  .extensions-card h3 { font-size: 23px; }
  .automation-card .capability-copy { padding-top: 28px; }
  .schedule-illustration { margin-inline: 27px; }
}
</style>
