<script setup lang="ts">
import type { LocalSkill } from '@buddy-shared/skills/skillApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { isSkillAvailable } from '@buddy-shared/skills/skillApi'
import { ErrorCircle16Regular } from '@vicons/fluent'
import { NSwitch, NTag, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import SkillIcon from '@/shared/ui/icon/SkillIcon.vue'

const props = defineProps<{
  skill: LocalSkill
  overriddenBy?: LocalSkill
  language: BuddyLocale
  inSpace: boolean
  busy: boolean
}>()
defineEmits<{ inspect: [skill: LocalSkill], locate: [skill: LocalSkill], enable: [skill: LocalSkill, value: boolean] }>()
const { t } = useBuddyI18n(() => props.language)
const overrideHint = computed(() => props.overriddenBy ? t(`desktop.skills.overrideHint.${props.overriddenBy.source}`) : '')
const toggleDisabled = computed(() => props.busy || (props.inSpace && !props.skill.spaceId))
</script>

<template>
  <article class="skill-row flex items-center gap-4 py-[0.9rem] px-0 border-b-1 border-b-solid border-b-border" :class="{ 'is-shadowed': skill.status === 'shadowed' }" :data-skill-id="skill.id" :data-skill-name="skill.name" :data-skill-source="skill.source">
    <div class="skill-row__content flex-1 min-w-0">
      <button class="skill-row__main flex w-full min-w-0 items-start gap-[0.8rem] p-[0.3rem] border-0 rounded-[0.4rem] bg-transparent text-fg text-left cursor-pointer hover:bg-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]" type="button" @click="$emit('inspect', skill)">
        <span class="skill-row__icon grid flex-none w-9 h-9 place-items-center border-1 border-solid border-accent-border rounded-[0.55rem] bg-accent-subtle text-accent-text"><DesktopIcon :component="SkillIcon" :size="22" /></span>
        <span class="grid min-w-0 gap-[0.3rem]">
          <span class="skill-row__heading flex flex-wrap items-center">
            <span class="skill-row__name text-[0.86rem] font-650 [overflow-wrap:anywhere]">{{ skill.name }}</span>
            <NTag v-if="skill.managedBy === 'application'" class="skill-row__builtin" size="small" :bordered="false">
              {{ t('desktop.skills.application') }}
            </NTag>
          </span>
          <span class="skill-row__description overflow-hidden text-muted text-[0.78rem] leading-[1.6]">{{ skill.description }}</span>
        </span>
      </button>
    </div>
    <div class="skill-row__actions flex items-center flex-none gap-[0.7rem]">
      <NTag v-if="skill.status === 'manual_only' || skill.status === 'invalid'" size="small" :bordered="false" :type="skill.status === 'invalid' ? 'warning' : 'default'">
        {{ t(`desktop.skills.status.${skill.status}`) }}
      </NTag>
      <NSwitch v-if="skill.managedBy !== 'directory'" :round="false" size="small" :value="skill.enabled" :disabled="toggleDisabled" :aria-disabled="toggleDisabled" :aria-label="t('desktop.skills.toggle', { name: skill.name })" @update:value="$emit('enable', skill, $event)" />
      <NTooltip v-if="overriddenBy">
        <template #trigger>
          <button class="skill-row__override grid w-6 h-6 place-items-center p-0 border-0 rounded-[3px] bg-transparent text-muted cursor-pointer focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px] hover:text-accent-text" type="button" :aria-label="overrideHint" @click="$emit('locate', overriddenBy)">
            <DesktopIcon :component="ErrorCircle16Regular" :size="18" />
          </button>
        </template>
        {{ overrideHint }}
        <template v-if="!isSkillAvailable(overriddenBy)">
          <br>{{ t('desktop.skills.overrideUnavailable') }}
        </template>
      </NTooltip>
    </div>
  </article>
</template>

<style scoped lang="scss">
.skill-row { scroll-margin: 1rem; }
.skill-row__icon { box-shadow: inset 0 1px 0 var(--buddy-surface-raised); }

.skill-row__heading { gap: 0.4rem 0.55rem; }
.skill-row__builtin { flex: none; color: var(--buddy-text-secondary); }
.skill-row__description { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.is-shadowed .skill-row__name, .is-shadowed .skill-row__description { color: var(--buddy-text-muted); }
@media (max-width: 900px) {
  .skill-row { align-items: flex-start; flex-wrap: wrap; gap: 0.6rem; }
  .skill-row__content { flex-basis: 100%; }
  .skill-row__actions:empty { display: none; }
  .skill-row__actions { margin-left: 3.35rem; }
}
</style>
