<script setup lang="ts">
import type { LocalTaskMark } from '@buddy-shared/conversation/taskMarkApi'
import type { DropdownOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { SYSTEM_UNREAD_MARK_ID } from '@buddy-shared/conversation/taskMarkApi'
import { Edit20Regular, MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NEllipsis, NTag, NTooltip } from 'naive-ui'
import { computed, h, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopTaskMarkSwatch from './DesktopTaskMarkSwatch.vue'

const props = defineProps<{
  mark: Pick<LocalTaskMark, 'id' | 'name' | 'description' | 'color'>
  disabled: boolean
  language: BuddyLocale
}>()
const emit = defineEmits<{ edit: [], remove: [] }>()
const { t } = useBuddyI18n(() => props.language)
const menuOpen = shallowRef(false)
const isSystem = computed(() => props.mark.id === SYSTEM_UNREAD_MARK_ID)
const actions = computed<DropdownOption[]>(() => [
  { key: 'edit', label: t('common.edit'), icon: () => h(DesktopIcon, { component: Edit20Regular, size: 16 }), disabled: props.disabled },
  { key: 'remove', label: t('common.delete'), icon: () => h(DesktopIcon, { name: 'delete', size: 16 }), disabled: props.disabled || isSystem.value },
])

function handleAction(action: string | number) {
  if (props.disabled)
    return
  if (action === 'edit')
    emit('edit')
  if (action === 'remove' && !isSystem.value)
    emit('remove')
}
</script>

<template>
  <div class="desktop-task-mark-item flex min-w-0 items-center pr-[6px] rounded-[6px]" :class="{ 'is-menu-open': menuOpen }" :data-mark-id="mark.id">
    <button class="desktop-task-mark-item__main flex min-w-0 min-h-[56px] flex-1 items-center gap-[10px] py-[9px] px-[8px] border-0 rounded-[6px] bg-transparent text-fg text-left cursor-pointer disabled:cursor-default ui-focus-ring" type="button" :disabled="disabled" @click="emit('edit')">
      <span class="desktop-task-mark-item__color grid w-[28px] h-[28px] flex-none place-items-center rounded-[6px]" :style="{ '--mark-color': mark.color }">
        <DesktopTaskMarkSwatch :color="mark.color" />
      </span>
      <span class="grid min-w-0 flex-1 grid-cols-[minmax(0,_1fr)] gap-[3px]">
        <span class="flex min-w-0 items-center gap-[6px]">
          <NEllipsis class="desktop-task-mark-item__name" :tooltip="{ width: 260 }">{{ mark.name }}</NEllipsis>
          <NTag v-if="isSystem" class="desktop-task-mark-item__badge" size="small" :bordered="false">{{ t('desktop.marks.system') }}</NTag>
        </span>
        <NEllipsis v-if="mark.description" class="desktop-task-mark-item__description" :tooltip="{ width: 320 }">{{ mark.description }}</NEllipsis>
      </span>
    </button>
    <div class="flex flex-none">
      <NTooltip v-if="isSystem">
        <template #trigger>
          <NButton class="desktop-task-mark-item__action" quaternary size="small" :disabled="disabled" :aria-label="t('common.edit')" @click="emit('edit')">
            <template #icon>
              <DesktopIcon :component="Edit20Regular" :size="16" />
            </template>
          </NButton>
        </template>
        {{ t('common.edit') }}
      </NTooltip>
      <NDropdown v-else v-model:show="menuOpen" trigger="click" placement="bottom-end" :options="actions" :disabled="disabled" @select="handleAction">
        <NButton class="desktop-task-mark-item__action" quaternary size="small" :disabled="disabled" :aria-label="t('desktop.tasks.moreActions')" :aria-expanded="menuOpen" aria-haspopup="menu">
          <template #icon>
            <DesktopIcon :component="MoreHorizontal20Regular" :size="16" />
          </template>
        </NButton>
      </NDropdown>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-task-mark-item {
  transition: background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);
}

.desktop-task-mark-item:hover,
.desktop-task-mark-item:focus-within,
.desktop-task-mark-item.is-menu-open {
  background: var(--buddy-nav-hover);
}

.desktop-task-mark-item__color {
  background: color-mix(in srgb, var(--mark-color) 10%, transparent);
}

.desktop-task-mark-item__name {
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.desktop-task-mark-item__badge {
  height: 18px;
  flex: none;
  padding: 0 5px;
  font-size: 10px;
}

.desktop-task-mark-item__description {
  max-width: 100%;
  color: var(--buddy-text-muted);
  font-size: 12px;
  line-height: 17px;
}

.desktop-task-mark-item__action {
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--buddy-text-muted);
}
</style>
