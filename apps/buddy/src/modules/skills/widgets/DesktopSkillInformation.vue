<script setup lang="ts">
import type { SkillDetail } from '@buddy-shared/skills/skillApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { skillInvocationName } from '@buddy-shared/skills/skillApi'
import { NDescriptions, NDescriptionsItem } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ detail: SkillDetail, language: BuddyLocale, spaceId: string | null }>()
const { t } = useBuddyI18n(() => props.language)
const skill = computed(() => props.detail.skill)
const metadata = computed(() => props.detail.metadata.filter(field => field.name !== 'name' && field.name !== 'description' && field.value.trim()))
const source = computed(() => {
  if (skill.value.plugin)
    return t('desktop.skills.pluginSource', { name: skill.value.plugin.extensionName })
  const label = skill.value.source === 'global' && !props.spaceId ? t('skill.source.global') : t(`desktop.skills.group.${skill.value.source}`)
  return skill.value.managedBy === 'application' ? `${label} · ${t('desktop.skills.application')}` : label
})
</script>

<template>
  <NDescriptions class="skill-information" bordered size="small" :column="1" label-placement="left" :label-style="{ width: '7.5rem', verticalAlign: 'top', overflowWrap: 'anywhere' }" :content-style="{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }">
    <NDescriptionsItem v-if="skill.description" :label="t('desktop.skills.detail.summary')">
      {{ skill.description }}
    </NDescriptionsItem>
    <NDescriptionsItem :label="t('desktop.skills.source')">
      {{ source }}
    </NDescriptionsItem>
    <NDescriptionsItem v-if="skill.plugin" :label="t('desktop.skills.pluginIdentity')">
      {{ skill.plugin.extensionId }}
    </NDescriptionsItem>
    <NDescriptionsItem v-if="skill.plugin" :label="t('desktop.skills.invocation')">
      ${{ skillInvocationName(skill) }}
    </NDescriptionsItem>
    <NDescriptionsItem v-if="skill.plugin" :label="t('desktop.skills.management')">
      {{ t('desktop.skills.pluginManaged') }}
    </NDescriptionsItem>
    <NDescriptionsItem :label="t('desktop.skills.path')">
      {{ skill.filePath }}
    </NDescriptionsItem>
    <NDescriptionsItem v-if="skill.origin && skill.managedBy !== 'application'" :label="t('desktop.skills.detail.originalSource')">
      {{ skill.origin.location }}
    </NDescriptionsItem>
    <NDescriptionsItem v-if="skill.origin?.commit" :label="t('desktop.skills.commit')">
      {{ skill.origin.commit }}
    </NDescriptionsItem>
    <NDescriptionsItem v-for="field in metadata" :key="field.name" :label="field.name">
      {{ field.value }}
    </NDescriptionsItem>
  </NDescriptions>
</template>

<style scoped>
.skill-information { min-width: 0; }
</style>
