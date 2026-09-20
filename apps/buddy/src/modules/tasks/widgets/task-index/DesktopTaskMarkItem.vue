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
  <div class="desktop-task-mark-item" :class="{ 'is-menu-open': menuOpen }" :data-mark-id="mark.id">
    <button class="desktop-task-mark-item__main" type="button" :disabled="disabled" @click="emit('edit')">
      <span class="desktop-task-mark-item__color" :style="{ '--mark-color': mark.color }">
        <DesktopTaskMarkSwatch :color="mark.color" />
      </span>
      <span class="desktop-task-mark-item__body">
        <span class="desktop-task-mark-item__identity">
          <NEllipsis class="desktop-task-mark-item__name" :tooltip="{ width: 260 }">{{ mark.name }}</NEllipsis>
          <NTag v-if="isSystem" class="desktop-task-mark-item__badge" size="small" :bordered="false">{{ t('desktop.marks.system') }}</NTag>
        </span>
        <NEllipsis v-if="mark.description" class="desktop-task-mark-item__description" :tooltip="{ width: 320 }">{{ mark.description }}</NEllipsis>
      </span>
    </button>
    <div class="desktop-task-mark-item__actions">
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

<style scoped>
.desktop-task-mark-item {
  display: flex;
  min-width: 0;
  align-items: center;
  padding-right: 6px;
  border-radius: 6px;
  transition: background-color var(--buddy-motion-state-duration) var(--buddy-motion-state-easing);
}

.desktop-task-mark-item:hover,
.desktop-task-mark-item:focus-within,
.desktop-task-mark-item.is-menu-open {
  background: var(--buddy-nav-hover);
}

.desktop-task-mark-item__main {
  display: flex;
  min-width: 0;
  min-height: 56px;
  flex: 1;
  align-items: center;
  gap: 10px;
  padding: 9px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--buddy-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.desktop-task-mark-item__main:disabled {
  cursor: default;
}

.desktop-task-mark-item__main:focus-visible {
  outline: 2px solid var(--buddy-focus-ring);
  outline-offset: -2px;
}

.desktop-task-mark-item__color {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  border-radius: 6px;
  background: color-mix(in srgb, var(--mark-color) 10%, transparent);
}

.desktop-task-mark-item__body {
  display: grid;
  min-width: 0;
  flex: 1;
  grid-template-columns: minmax(0, 1fr);
  gap: 3px;
}

.desktop-task-mark-item__identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
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

.desktop-task-mark-item__actions {
  display: flex;
  flex: none;
}

.desktop-task-mark-item__action {
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--buddy-text-muted);
}
</style>
