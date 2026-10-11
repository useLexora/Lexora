<script setup lang="ts">
import type { LocalSkill } from '@buddy-shared/skills/skillApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowSync20Regular, Code20Regular, Eye20Regular, FolderOpen20Regular, Globe20Regular } from '@vicons/fluent'
import { NButton, NPopconfirm, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopContextAction from '@/shared/ui/files/DesktopContextAction.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  skill: LocalSkill
  language: BuddyLocale
  spaceId: string | null
  busy: boolean
  showSource: boolean
}>()
defineEmits<{ reveal: [], global: [], update: [], remove: [] }>()
const source = defineModel<boolean>('source', { required: true })
const { t } = useBuddyI18n(() => props.language)
const mutationDisabled = computed(() => props.busy || props.skill.busy)
</script>

<template>
  <div class="flex flex-none items-center gap-1 text-muted">
    <DesktopContextAction v-if="showSource" :icon="source ? Eye20Regular : Code20Regular" :label="t(source ? 'desktop.skills.detail.rendered' : 'desktop.skills.detail.source')" :active="source" @click="source = !source" />
    <DesktopContextAction :icon="FolderOpen20Regular" :label="t('desktop.skills.reveal')" :disabled="busy" @click="$emit('reveal')" />
    <DesktopContextAction v-if="spaceId && !skill.spaceId" :icon="Globe20Regular" :label="t('desktop.skills.manageGlobal')" @click="$emit('global')" />
    <NTooltip v-if="skill.canUpdate" :delay="350">
      <template #trigger>
        <span class="skill-detail__action inline-flex">
          <NButton class="buddy-icon-button" quaternary :disabled="mutationDisabled" :aria-label="t('desktop.skills.update')" @click="$emit('update')">
            <template #icon>
              <DesktopIcon :component="ArrowSync20Regular" />
            </template>
          </NButton>
        </span>
      </template>
      {{ t(skill.busy ? 'desktop.skills.busyHint' : 'desktop.skills.update') }}
    </NTooltip>
    <NTooltip v-if="skill.canRemove" :delay="350">
      <template #trigger>
        <span class="skill-detail__action inline-flex">
          <NPopconfirm :disabled="mutationDisabled" @positive-click="$emit('remove')">
            <template #trigger>
              <NButton class="buddy-icon-button skill-detail__remove" quaternary :disabled="mutationDisabled" :aria-label="t('desktop.skills.remove')">
                <template #icon>
                  <DesktopIcon name="delete" />
                </template>
              </NButton>
            </template>
            {{ t('desktop.skills.removeConfirm', { name: skill.name }) }}
          </NPopconfirm>
        </span>
      </template>
      {{ t(skill.busy ? 'desktop.skills.busyHint' : 'desktop.skills.remove') }}
    </NTooltip>
  </div>
</template>

<style scoped lang="scss">
.skill-detail__action .n-button { width: 28px; height: 28px; }
.skill-detail__remove:not(:disabled):hover { color: var(--buddy-status-danger-text); }
</style>
