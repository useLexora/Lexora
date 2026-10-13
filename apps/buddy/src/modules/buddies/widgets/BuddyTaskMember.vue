<script setup lang="ts">
import type { DropdownOption } from 'naive-ui'
import { MoreHorizontal20Regular, Star16Regular } from '@vicons/fluent'
import { NButton, NDropdown, NTag } from 'naive-ui'
import { computed, h, toRef } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { buddyLabels } from '../buddyLabels'
import { useBuddyIdentity } from '../state/useBuddyIdentity'
import BuddyAvatar from './BuddyAvatar.vue'
import BuddyRemoveMemberIcon from './BuddyRemoveMemberIcon.vue'

const props = defineProps<{ buddyId: string, leader: boolean, disabled: boolean, removed?: boolean, activity?: 'working' | 'waiting' }>()
const emit = defineEmits<{ select: [], remove: [] }>()
const buddy = useBuddyIdentity(toRef(props, 'buddyId'))
const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const available = computed(() => buddy.value?.enabled && !buddy.value.deletedAt)
const actions = computed<DropdownOption[]>(() => [
  { key: 'select', label: labels.value.makeLeader, disabled: props.disabled || !available.value, icon: () => h(DesktopIcon, { component: Star16Regular, size: 16 }), props: { role: 'menuitem' } },
  { type: 'divider', key: 'divider' },
  { key: 'remove', label: labels.value.removeMember, disabled: props.disabled, icon: () => h(DesktopIcon, { component: BuddyRemoveMemberIcon, size: 16 }), props: { role: 'menuitem' } },
])

function selectAction(key: string) {
  if (props.disabled)
    return
  if (key === 'select' && available.value)
    emit('select')
  else if (key === 'remove')
    emit('remove')
}
</script>

<template>
  <div class="px-3 py-2.5" :data-member-id="buddyId">
    <div class="flex items-center gap-3">
      <div class="buddy-member-avatar relative size-8 shrink-0" :data-activity="activity">
        <BuddyAvatar :buddy-id="buddyId" :src="buddy?.avatar" class="size-full" />
      </div>
      <div class="min-w-0 flex-1">
        <span class="block truncate text-[13px] text-fg">{{ buddy?.name || labels.unknown }}</span>
        <span v-if="buddy && !available" class="text-[11px] text-muted">{{ labels.unavailableChoice }}</span>
        <span v-else-if="removed && activity" class="text-[11px] text-muted">{{ labels.removedMember }}</span>
      </div>
      <slot v-if="activity" name="actions" />
      <NTag v-else-if="leader" size="small" :bordered="false" type="primary">
        {{ labels.currentLeader }}
      </NTag>
      <span v-else-if="removed" class="text-[11px] text-muted">{{ labels.removedMember }}</span>
      <NDropdown v-else trigger="click" placement="bottom-end" :options="actions" @select="selectAction">
        <NButton size="small" quaternary class="buddy-icon-button text-muted" :aria-label="labels.more" :disabled="disabled">
          <template #icon>
            <DesktopIcon :component="MoreHorizontal20Regular" :size="18" />
          </template>
        </NButton>
      </NDropdown>
    </div>
    <slot name="activity" />
  </div>
</template>

<style scoped lang="scss">
.buddy-member-avatar[data-activity]::after {
  content: '';
  position: absolute;
  inset: -3px;
  border: 1.5px solid color-mix(in srgb, var(--buddy-accent-solid) 30%, transparent);
  border-radius: 50%;
  pointer-events: none;
}

.buddy-member-avatar[data-activity='working']::after {
  border-top-color: var(--buddy-accent-solid);
  border-right-color: var(--buddy-accent-solid);
  animation: buddy-member-working 2.4s linear infinite;
}

@keyframes buddy-member-working {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .buddy-member-avatar[data-activity='working']::after {
    animation: none;
  }
}
</style>
