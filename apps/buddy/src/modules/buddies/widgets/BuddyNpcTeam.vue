<script setup lang="ts">
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { BuddySettings } from '@buddy-shared/buddies/buddySettings'
import { Add20Regular, Dismiss20Regular, PeopleTeam20Regular } from '@vicons/fluent'
import { NButton, NInputNumber, NScrollbar, NSwitch, NTooltip } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { buddyLabels } from '../buddyLabels'
import BuddyAvatar from './BuddyAvatar.vue'
import BuddyNpcRecruitDialog from './BuddyNpcRecruitDialog.vue'
import BuddySettingsSection from './BuddySettingsSection.vue'

const props = defineProps<{ buddies: readonly LocalBuddy[], disabled: boolean }>()
const enabled = defineModel<boolean>('enabled', { required: true })
const npcIds = defineModel<string[]>('npcIds', { required: true })
const concurrency = defineModel<BuddySettings['npcConcurrency']>('concurrency', { required: true })
const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const showRecruitDialog = shallowRef(false)
const teamLabelId = useId()
const teamDescriptionId = useId()
const concurrencyLabelId = useId()
const concurrencyDescriptionId = useId()

const lastLimit = shallowRef(concurrency.value.mode === 'limited' ? concurrency.value.limit : 5)
const modes = computed(() => [{ value: 'limited', label: labels.value.limited }, { value: 'unlimited', label: labels.value.unlimited }] as const)
const members = computed(() => npcIds.value.map(id => ({ id, buddy: props.buddies.find(buddy => buddy.kind === 'npc' && buddy.id === id) })))

function selectMode(mode: 'limited' | 'unlimited') {
  if (concurrency.value.mode === 'limited')
    lastLimit.value = concurrency.value.limit
  concurrency.value = mode === 'limited' ? { mode, limit: lastLimit.value } : { mode }
}

function selectLimit(limit: number | null) {
  if (limit !== null)
    concurrency.value = { mode: 'limited', limit }
}

function remove(id: string) {
  npcIds.value = npcIds.value.filter(value => value !== id)
}

function onSaveRecruited(selectedIds: string[]) {
  npcIds.value = selectedIds
}
</script>

<template>
  <BuddySettingsSection :heading="labels.npcTeam" :icon="PeopleTeam20Regular" data-testid="buddy-npc-team">
    <template #badge>
      <span class="rounded-micro bg-subtle px-2 py-0.5 text-[11px] font-medium text-muted tabular-nums">
        {{ members.length }}
      </span>
      <span v-if="!enabled" class="rounded-micro bg-subtle px-2 py-0.5 text-[11px] font-medium text-muted">
        {{ labels.paused }}
      </span>
    </template>

    <template #actions>
      <NButton size="small" type="primary" :disabled="disabled" @click="showRecruitDialog = true">
        <template #icon>
          <DesktopIcon :component="Add20Regular" :size="16" />
        </template>
        {{ labels.recruitNpc }}
      </NButton>
    </template>

    <div class="border-t border-t-solid border-t-border px-4 py-3">
      <div class="flex items-center justify-between gap-3">
        <span :id="teamLabelId" class="text-[13px] font-600 text-fg">{{ labels.npcTeamEnabled }}</span>
        <NSwitch v-model:value="enabled" :round="false" :aria-labelledby="teamLabelId" :aria-describedby="teamDescriptionId" :disabled="disabled" />
      </div>
      <p :id="teamDescriptionId" class="m-0 mt-2 text-[12px] text-muted leading-relaxed">
        {{ enabled ? labels.npcTeamEnabledHint : labels.npcTeamDisabledHint }}
      </p>
    </div>

    <div class="border-y border-y-solid border-y-border px-4 py-3" data-testid="buddy-npc-concurrency">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span :id="concurrencyLabelId" class="text-[13px] font-600 text-fg">{{ labels.concurrencyLimit }}</span>
        <div class="flex flex-wrap items-center gap-2">
          <DesktopSegmentedControl :aria-labelledby="concurrencyLabelId" :aria-describedby="concurrencyDescriptionId" :model-value="concurrency.mode" :options="modes" :disabled="disabled" @update:model-value="selectMode" />
          <NInputNumber
            v-if="concurrency.mode === 'limited'"
            class="w-26"
            :value="concurrency.limit"
            :input-props="{ 'aria-labelledby': concurrencyLabelId, 'aria-describedby': concurrencyDescriptionId }"
            :min="1"
            :max="Number.MAX_SAFE_INTEGER"
            :precision="0"
            :update-value-on-input="false"
            :disabled="disabled"
            @update:value="selectLimit"
          />
        </div>
      </div>
      <p :id="concurrencyDescriptionId" class="m-0 mt-2 text-[12px] text-muted leading-relaxed">
        {{ labels.concurrencyDescription }}
      </p>
    </div>

    <NScrollbar v-if="members.length" class="max-h-[min(400px,50dvh)]" container-class="overscroll-y-contain" trigger="none" data-testid="buddy-npc-members">
      <ul class="m-0 list-none p-0" :aria-label="labels.npcTeam">
        <li v-for="(member, index) in members" :key="member.id" class="flex min-h-17 box-border items-center gap-3 px-4 py-3 border-b border-b-solid border-b-border last:border-b-0" :data-npc-id="member.id">
          <BuddyAvatar
            :buddy-id="member.id"
            :src="member.buddy?.avatar"
            class="buddy-npc-avatar size-9"
            :class="{ 'is-inactive': !enabled || !member.buddy?.enabled }"
            :style="{ '--npc-transition-delay': `${Math.min(index, 4) * 16}ms` }"
          />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <strong class="text-[13px] font-600 text-fg break-all">{{ member.buddy?.name ?? member.id }}</strong>
              <span v-if="!member.buddy || !member.buddy.enabled" class="text-[12px] text-muted">{{ member.buddy ? labels.paused : labels.unavailableChoice }}</span>
            </div>
            <p v-if="member.buddy?.description" class="m-0 mt-1 text-[12px] text-muted leading-relaxed break-words line-clamp-2">
              {{ member.buddy.description }}
            </p>
          </div>
          <NTooltip>
            <template #trigger>
              <NButton quaternary size="small" class="buddy-icon-button" :aria-label="labels.removeNpc" :disabled="disabled" @click="remove(member.id)">
                <template #icon>
                  <DesktopIcon :component="Dismiss20Regular" />
                </template>
              </NButton>
            </template>
            {{ labels.removeNpc }}
          </NTooltip>
        </li>
      </ul>
    </NScrollbar>
    <p v-else class="m-0 px-4 py-6 text-center text-[13px] text-muted">
      {{ labels.noNpcs }}
    </p>

    <BuddyNpcRecruitDialog
      v-model:show="showRecruitDialog"
      :buddies="buddies"
      :selected-ids="npcIds"
      :disabled="disabled"
      @save="onSaveRecruited"
    />
  </BuddySettingsSection>
</template>

<style scoped lang="scss">
.buddy-npc-avatar {
  filter: grayscale(0);
  opacity: 1;
  transform: translateY(0);
  transition: filter 180ms ease, opacity 180ms ease, transform 180ms ease;
  transition-delay: var(--npc-transition-delay);

  &.is-inactive {
    filter: grayscale(1);
    opacity: 0.6;
    transform: translateY(1px);
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
}
</style>
