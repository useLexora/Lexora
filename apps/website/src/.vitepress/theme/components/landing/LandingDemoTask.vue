<script setup lang="ts">
import type { LandingContent } from './landingContent'
import { computed, onBeforeUnmount, shallowRef } from 'vue'
import LandingIcon from './LandingIcon.vue'

const props = defineProps<{ content: LandingContent['demo'], scenario: LandingContent['demo']['scenarios'][number] }>()
defineEmits<{ openArtifact: [] }>()
const completedSteps = shallowRef(props.scenario.steps.length)
const running = computed(() => completedSteps.value < props.scenario.steps.length)
let timer: ReturnType<typeof setInterval> | undefined

function replay() {
  clearInterval(timer)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    return
  completedSteps.value = 0
  timer = setInterval(() => {
    completedSteps.value++
    if (!running.value)
      clearInterval(timer)
  }, 650)
}

onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="demo-task" :aria-busy="running">
    <div class="demo-transcript">
      <div class="user-message">
        <span class="user-mark" aria-hidden="true">↗</span><p>{{ scenario.prompt }}</p>
      </div>
      <div class="assistant-identity">
        <span class="assistant-mark"><LandingIcon /></span><strong>Lexora</strong><span class="task-status" role="status">{{ running ? content.running : content.completed }}</span>
      </div>
      <details class="demo-activity">
        <summary><LandingIcon name="check" /><span>{{ content.activity }} · {{ completedSteps }} / {{ scenario.steps.length }}</span><LandingIcon name="chevron" /></summary>
        <ol>
          <li v-for="(step, index) in scenario.steps" :key="step" :class="{ pending: index >= completedSteps }">
            <LandingIcon :name="index < completedSteps ? 'check' : 'clock'" />{{ step }}
          </li>
        </ol>
      </details>
      <div class="demo-answer" :class="{ 'is-running': running }">
        <h3>{{ scenario.resultTitle }}</h3>
        <p class="answer-summary">
          {{ scenario.summary }}
        </p>
        <h4>{{ content.highlights }}</h4>
        <ul class="answer-points">
          <li v-for="line in scenario.lines" :key="line">
            {{ line }}
          </li>
        </ul>
        <div class="outputs-heading">
          {{ content.result }}<span>1</span>
        </div>
        <button class="demo-artifact" :disabled="running" @click="$emit('openArtifact')">
          <span class="file-icon"><LandingIcon name="file" /><small>MD</small></span>
          <span><strong class="output-top">{{ scenario.file }}</strong><small>{{ content.openFile }}</small></span>
          <LandingIcon name="expand" />
        </button>
      </div>
    </div>
    <div class="demo-composer">
      <p>{{ content.composer }}</p>
      <div class="composer-tools">
        <span><LandingIcon name="spark" />{{ content.localDemo }}</span>
        <button class="replay-button" :disabled="running" @click="replay">
          <LandingIcon name="replay" />{{ running ? content.running : content.replay }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.demo-task { min-width: 0; display: flex; flex-direction: column; background: var(--demo-bg); }
.demo-transcript { padding: 28px clamp(24px, 4vw, 58px) 30px; flex: 1; }
.user-message { display: flex; align-items: flex-start; justify-content: flex-end; gap: 12px; margin-bottom: 28px; }
.user-mark { flex: 0 0 27px; height: 27px; display: grid; place-items: center; background: var(--demo-soft); color: var(--demo-muted); border-radius: 50%; font-size: 14px; }
.user-message p { background: var(--demo-soft); border: 1px solid var(--demo-line); padding: 12px 16px; border-radius: 4px 12px 12px; font-size: 13px; line-height: 1.9; max-width: 540px; }
.assistant-identity { display: flex; align-items: center; gap: 9px; font-size: 12px; }
.assistant-mark { width: 27px; height: 27px; display: grid; place-items: center; color: var(--demo-accent); background: var(--demo-soft); border-radius: 9px; }
.assistant-mark svg { width: 17px; height: 17px; }
.assistant-identity strong { font-weight: 600; }
.task-status { margin-left: auto; font-size: 10px; color: var(--demo-muted); }
.demo-activity { margin: 14px 0 22px 36px; color: var(--demo-muted); }
.demo-activity summary { display: flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; font-size: 11px; list-style: none; }
.demo-activity summary::-webkit-details-marker { display: none; }
.demo-activity svg { width: 14px; height: 14px; flex-shrink: 0; }
.demo-activity summary > svg:last-child { width: 12px; transition: transform .2s; }
.demo-activity[open] summary > svg:last-child { transform: rotate(90deg); }
.demo-activity ol { padding: 7px 0 4px 7px; margin: 0; list-style: none; display: grid; gap: 12px; }
.demo-activity li { display: flex; gap: 9px; align-items: center; font-size: 11px; }
.demo-activity li svg { color: var(--demo-accent); }
.pending { opacity: .45; }
.demo-answer { margin-left: 36px; transition: opacity .2s; }
.demo-answer.is-running { opacity: .3; }
.demo-answer h3 { font-size: 21px; line-height: 1.5; font-weight: 600; letter-spacing: -.5px; }
.answer-summary { margin-top: 12px; font-size: 13px; line-height: 1.9; color: var(--demo-muted); }
.demo-answer h4 { margin: 20px 0 10px; font-size: 12px; font-weight: 600; }
.answer-points { list-style: disc; padding-left: 18px; display: grid; gap: 9px; font-size: 12px; line-height: 1.8; }
.answer-points li::marker { color: var(--demo-accent); }
.outputs-heading { font-size: 11px; font-weight: 600; display: flex; gap: 9px; margin: 25px 0 11px; }
.outputs-heading span { color: var(--demo-muted); font-weight: 400; }
.demo-artifact { width: min(100%, 350px); display: flex; align-items: center; gap: 12px; padding: 13px; background: var(--demo-soft); border: 1px solid var(--demo-line); border-radius: 9px; text-align: left; cursor: pointer; transition: border-color .2s, transform .2s; }
.demo-artifact:hover { border-color: var(--demo-accent); transform: translateY(-2px); }
.demo-artifact:disabled { cursor: wait; }
.file-icon { display: grid; place-items: center; width: 30px; flex-shrink: 0; color: var(--demo-accent); }
.file-icon > svg { width: 23px; height: 23px; }
.file-icon small { font-family: var(--site-mono); font-size: 7px; }
.demo-artifact > span:nth-child(2) { min-width: 0; }
.output-top { display: block; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
.demo-artifact > span > small { display: block; font-size: 9px; margin-top: 3px; color: var(--demo-muted); }
.demo-artifact > svg { margin-left: auto; width: 15px; height: 15px; color: var(--demo-muted); flex-shrink: 0; }
.demo-composer { margin: 0 30px 23px; padding: 16px; border: 1px solid var(--demo-line); border-radius: 12px; background: var(--demo-soft); }
.demo-composer > p { color: var(--demo-muted); font-size: 12px; line-height: 1.7; }
.composer-tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 21px; }
.composer-tools > span { display: flex; align-items: center; gap: 6px; color: var(--demo-muted); font-size: 9px; }
.composer-tools svg { width: 13px; height: 13px; }
.replay-button { display: flex; align-items: center; gap: 7px; min-height: 36px; padding: 0 12px; background: var(--demo-accent); color: #fff; border-radius: 6px; cursor: pointer; font-size: 10px; }
.replay-button:disabled { opacity: .65; cursor: wait; }
@media (max-width: 760px) {
  .demo-transcript { padding: 22px 18px; }
  .user-message { gap: 8px; }
  .user-message p { font-size: 12px; padding: 10px 12px; }
  .demo-answer, .demo-activity { margin-left: 0; }
  .demo-answer h3 { font-size: 20px; }
  .demo-composer { margin: 0 16px 18px; padding: 13px; }
  .composer-tools { gap: 7px; }
}
</style>
