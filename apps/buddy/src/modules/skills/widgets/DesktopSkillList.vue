<script setup lang="ts">
import type { LocalSkill } from '@buddy-shared/skills/skillApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, nextTick, useId, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import SkillIcon from '@/shared/ui/icon/SkillIcon.vue'
import DesktopSkillRow from './DesktopSkillRow.vue'

const props = defineProps<{
  skills: readonly LocalSkill[]
  catalog: readonly LocalSkill[]
  language: BuddyLocale
  inSpace: boolean
  filtered: boolean
  busy: boolean
}>()
defineEmits<{ inspect: [skill: LocalSkill], locate: [skill: LocalSkill], enable: [skill: LocalSkill, value: boolean] }>()
const source = defineModel<LocalSkill['source']>('source', { required: true })
const root = useTemplateRef<HTMLElement>('root')
const panelId = useId()
const { t } = useBuddyI18n(() => props.language)
const byId = computed(() => new Map(props.catalog.map(skill => [skill.id, skill])))
const groups = computed(() => (['directory', 'space', 'global'] as const)
  .map(source => ({ source, skills: props.skills.filter(skill => skill.source === source) })))
const visible = computed(() => props.inSpace ? groups.value.find(group => group.source === source.value)?.skills ?? [] : props.skills)

async function navigate(event: KeyboardEvent, index: number) {
  const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!offset && event.key !== 'Home' && event.key !== 'End')
    return
  event.preventDefault()
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? groups.value.length - 1 : (index + offset + groups.value.length) % groups.value.length
  source.value = groups.value[target]!.source
  await nextTick()
  root.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus()
}

async function reveal(skill: LocalSkill) {
  source.value = skill.source
  await nextTick()
  const row = Array.from(root.value?.querySelectorAll<HTMLElement>('.skill-row') ?? []).find(element => element.dataset.skillId === skill.id)
  row?.scrollIntoView({ block: 'center' })
  row?.querySelector<HTMLButtonElement>('.skill-row__main')?.focus({ preventScroll: true })
}
defineExpose({ reveal })
</script>

<template>
  <div ref="root" class="skills-list grid gap-2">
    <div v-if="inSpace" class="skills-list__tabs flex gap-6 overflow-x-auto border-b-1 border-b-solid border-b-border" role="tablist" :aria-label="t('desktop.skills.source')">
      <button v-for="(group, index) in groups" :id="`${panelId}-${group.source}`" :key="group.source" type="button" role="tab" :data-source="group.source" :aria-selected="source === group.source" :aria-controls="panelId" :tabindex="source === group.source ? 0 : -1" @click="source = group.source" @keydown="navigate($event, index)">
        {{ t(`desktop.skills.group.${group.source}`) }}
        <span class="skills-list__count">{{ group.skills.length }}</span>
      </button>
    </div>
    <div v-else class="skills-list__summary">
      {{ t('desktop.skills.count', { count: visible.length }) }}
    </div>
    <div :id="panelId" :role="inSpace ? 'tabpanel' : undefined" :aria-labelledby="inSpace ? `${panelId}-${source}` : undefined">
      <DesktopSkillRow v-for="skill in visible" :key="skill.id" :skill="skill" :overridden-by="byId.get(skill.shadowedBy ?? '')" :language="language" :in-space="inSpace" :busy="busy" @inspect="$emit('inspect', $event)" @locate="$emit('locate', $event)" @enable="(skill, value) => $emit('enable', skill, value)" />
      <div v-if="!visible.length" class="skills-list__empty grid min-h-40 gap-[0.65rem] py-8 px-4 text-muted text-center">
        <DesktopIcon :component="SkillIcon" :size="30" />
        <p>{{ t(filtered ? 'desktop.skills.noMatches' : inSpace ? `desktop.skills.groupEmpty.${source}` : 'desktop.skills.empty') }}</p>
        <p v-if="!filtered && !inSpace">
          {{ t('desktop.skills.emptyHint') }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.skills-list__tabs button { position: relative; display: inline-flex; flex: none; align-items: center; gap: 0.4rem; border: 0; padding: 0.75rem 0; background: transparent; color: var(--buddy-text-secondary); font: inherit; font-size: 0.8rem; cursor: pointer; white-space: nowrap; }
.skills-list__tabs button:hover, .skills-list__tabs button[aria-selected="true"] { color: var(--buddy-accent-text); }
.skills-list__tabs button[aria-selected="true"]::after { position: absolute; right: 0; bottom: 0; left: 0; height: 2px; background: currentColor; content: ''; }
.skills-list__tabs button:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: -2px; border-radius: 3px; }
.skills-list__count, .skills-list__summary { color: var(--buddy-text-muted); font-size: 0.75rem; }
.skills-list__empty { justify-items: center; place-content: center; }
.skills-list__empty p { margin: 0; font-size: 0.8rem; }
</style>
