<script setup lang="ts">
import type { LocalAutomationListItem } from '@buddy-shared/automation/automationApi'

import type { DropdownOption } from 'naive-ui'
import type { HTMLAttributes } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import {
  MoreHorizontal20Regular,
  Pause20Regular,
  Play20Regular,
} from '@vicons/fluent'
import { NButton, NDropdown, NEmpty, NModal } from 'naive-ui'
import { computed, h, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import {
  automationBlockedDescriptionKey,
  formatAutomationInstant,
  formatAutomationSchedule,
} from '../../model/automationPresentation'

const props = defineProps<{
  automations: ReadonlyArray<LocalAutomationListItem>
  language: BuddyLocale
  pendingAutomationIds: ReadonlySet<string>
}>()
const emit = defineEmits<{
  create: []
  delete: [automation: LocalAutomationListItem]
  edit: [automation: LocalAutomationListItem]
  pause: [automation: LocalAutomationListItem]
  resume: [automation: LocalAutomationListItem]
  runNow: [automation: LocalAutomationListItem]
}>()
const { t } = useBuddyI18n(() => props.language)
const deleteTarget = shallowRef<LocalAutomationListItem | null>(null)
const dropdownItemProps: HTMLAttributes = { role: 'menuitem' }
const deletePending = computed(() => (
  deleteTarget.value !== null && props.pendingAutomationIds.has(deleteTarget.value.id)
))
const deleteMessage = computed(() => t('desktop.automations.deleteMessage', {
  name: deleteTarget.value?.name ?? '',
}))

function actionOptions(automation: LocalAutomationListItem): DropdownOption[] {
  const lifecycleAction = automation.status === 'active'
    ? {
        icon: () => h(DesktopIcon, { component: Pause20Regular }),
        key: 'pause',
        label: t('desktop.automations.action.pause'),
        props: dropdownItemProps,
      }
    : automation.status === 'paused' || automation.status === 'blocked'
      ? {
          icon: () => h(DesktopIcon, { component: Play20Regular }),
          key: 'resume',
          label: t('desktop.automations.action.resume'),
          props: dropdownItemProps,
        }
      : null
  return [
    ...(lifecycleAction ? [lifecycleAction] : []),
    {
      icon: () => h(DesktopIcon, { name: 'delete' }),
      key: 'delete',
      label: t('desktop.automations.action.delete'),
      props: dropdownItemProps,
    },
  ]
}

function handleAction(automation: LocalAutomationListItem, action: string | number): void {
  if (action === 'pause')
    emit('pause', automation)
  if (action === 'resume')
    emit('resume', automation)
  if (action === 'delete')
    deleteTarget.value = automation
}

function confirmDelete(): void {
  if (!deleteTarget.value)
    return
  emit('delete', deleteTarget.value)
  deleteTarget.value = null
}

function isPending(automation: LocalAutomationListItem): boolean {
  return props.pendingAutomationIds.has(automation.id)
}
</script>

<template>
  <div v-if="automations.length" class="desktop-automation-plan-list">
    <article
      v-for="automation in automations"
      :key="automation.id"
      class="desktop-automation-plan"
      :class="`is-${automation.status}`"
    >
      <button
        class="desktop-automation-plan__body"
        type="button"
        @click="emit('edit', automation)"
      >
        <span class="desktop-automation-plan__summary">
          <strong class="desktop-automation-plan__name">{{ automation.name }}</strong>
          <span class="desktop-automation-plan__schedule">
            {{ formatAutomationSchedule(automation, language, t) }}
          </span>
        </span>
        <span
          v-if="automation.status === 'blocked'"
          class="desktop-automation-plan__blocked"
        >
          {{ t(automationBlockedDescriptionKey(automation)) }}
        </span>
      </button>

      <div class="desktop-automation-plan__trailing">
        <span class="desktop-automation-plan__timing">
          {{ automation.nextRunAt
            ? t('desktop.automations.meta.nextRun', {
              time: formatAutomationInstant(automation.nextRunAt, language, automation.timing.timezone),
            })
            : t('desktop.automations.meta.noNextRun') }}
        </span>
        <div class="desktop-automation-plan__actions">
          <NButton
            quaternary
            circle
            size="small"
            :aria-label="t('desktop.automations.action.runNow')"
            :loading="isPending(automation)"
            @click.stop="emit('runNow', automation)"
          >
            <template #icon>
              <DesktopIcon :component="Play20Regular" />
            </template>
          </NButton>
          <NDropdown
            trigger="click"
            :options="actionOptions(automation)"
            @select="handleAction(automation, $event)"
          >
            <NButton
              quaternary
              circle
              size="small"
              :aria-label="t('desktop.automations.action.more')"
              :disabled="isPending(automation)"
            >
              <template #icon>
                <DesktopIcon :component="MoreHorizontal20Regular" />
              </template>
            </NButton>
          </NDropdown>
        </div>
      </div>
    </article>
  </div>

  <NEmpty v-else class="desktop-automation-plan-list__empty">
    <template #default>
      <strong>{{ t('desktop.automations.empty') }}</strong>
      <p>{{ t('desktop.automations.emptyDescription') }}</p>
      <NButton type="primary" @click="emit('create')">
        {{ t('desktop.automations.add') }}
      </NButton>
    </template>
  </NEmpty>

  <NModal
    :show="deleteTarget !== null"
    preset="dialog"
    type="warning"
    :title="t('desktop.automations.deleteTitle')"
    @update:show="!$event && (deleteTarget = null)"
  >
    {{ deleteMessage }}
    <template #action>
      <NButton @click="deleteTarget = null">
        {{ t('desktop.automations.editor.cancel') }}
      </NButton>
      <NButton type="error" :loading="deletePending" @click="confirmDelete">
        {{ t('desktop.automations.action.delete') }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-automation-plan-list {
  display: grid;
  gap: 2px;
}

.desktop-automation-plan {
  display: grid;
  min-height: 46px;
  grid-template-columns: minmax(0, 1fr) minmax(150px, auto);
  align-items: center;
  gap: 18px;
  border-radius: var(--buddy-radius-micro);
  padding: 0 12px;

  &:hover,
  &:focus-within {
    background: var(--buddy-surface-subtle);
  }
}

.desktop-automation-plan__body {
  display: grid;
  min-width: 0;
  gap: 3px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 6px 0;
  text-align: left;

  &:focus-visible {
    border-radius: var(--n-border-radius, 3px);
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: 2px;
  }
}

.desktop-automation-plan__summary {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 10px;
}

.desktop-automation-plan__name {
  overflow: hidden;
  flex: none;
  color: var(--buddy-text-strong);
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-automation-plan__schedule,
.desktop-automation-plan__timing,
.desktop-automation-plan__blocked {
  overflow: hidden;
  color: var(--buddy-text-secondary);
  font-size: 12px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-automation-plan__blocked {
  color: var(--buddy-status-warning-text);
}

.desktop-automation-plan__trailing {
  position: relative;
  display: flex;
  min-width: 150px;
  min-height: 34px;
  align-items: center;
  justify-content: flex-end;
}

.desktop-automation-plan__timing {
  transition: opacity 120ms ease;
}

.desktop-automation-plan__actions {
  position: absolute;
  right: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

.desktop-automation-plan:hover .desktop-automation-plan__timing,
.desktop-automation-plan:focus-within .desktop-automation-plan__timing {
  opacity: 0;
}

.desktop-automation-plan:hover .desktop-automation-plan__actions,
.desktop-automation-plan:focus-within .desktop-automation-plan__actions {
  opacity: 1;
  pointer-events: auto;
}

.desktop-automation-plan-list__empty {
  min-height: 360px;
  margin: 0;
  padding-top: clamp(72px, 14vh, 132px);

  :deep(.n-empty__description) {
    display: grid;
    max-width: 420px;
    justify-items: center;
    gap: 10px;
    text-align: center;
  }

  strong {
    color: var(--buddy-text-strong);
    font-size: 16px;
  }

  p {
    margin: 0 0 6px;
    line-height: 1.6;
  }
}

@media (max-width: 760px) {
  .desktop-automation-plan {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .desktop-automation-plan__schedule {
    display: none;
  }

  .desktop-automation-plan__trailing {
    min-width: 76px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-automation-plan__timing,
  .desktop-automation-plan__actions {
    transition: none;
  }
}
</style>
