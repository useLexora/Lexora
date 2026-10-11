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
  <div v-if="automations.length" class="desktop-automation-plan-list grid gap-[2px]">
    <article
      v-for="automation in automations"
      :key="automation.id"
      class="desktop-automation-plan grid min-h-[46px] grid-cols-[minmax(0,_1fr)_minmax(150px,_auto)] items-center gap-[18px] rounded-micro py-0 px-[12px] hover:bg-hover focus-within:bg-hover"
      :class="`is-${automation.status}`"
    >
      <button
        class="desktop-automation-plan__body grid min-w-0 gap-[3px] border-0 bg-transparent text-inherit cursor-pointer py-[6px] px-0 text-left focus-visible:rounded-[var(--n-border-radius,_3px)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]"
        type="button"
        @click="emit('edit', automation)"
      >
        <span class="flex min-w-0 items-baseline gap-[10px]">
          <strong class="overflow-hidden flex-none text-strong text-[14px] font-650 text-ellipsis whitespace-nowrap">{{ automation.name }}</strong>
          <span class="desktop-automation-plan__schedule">
            {{ formatAutomationSchedule(automation, language, t) }}
          </span>
        </span>
        <span
          v-if="automation.status === 'blocked'"
          class="desktop-automation-plan__blocked text-warning"
        >
          {{ t(automationBlockedDescriptionKey(automation)) }}
        </span>
      </button>

      <div class="desktop-automation-plan__trailing relative flex min-w-[150px] min-h-[34px] items-center justify-end">
        <span class="desktop-automation-plan__timing">
          {{ automation.nextRunAt
            ? t('desktop.automations.meta.nextRun', {
              time: formatAutomationInstant(automation.nextRunAt, language, automation.timing.timezone),
            })
            : t('desktop.automations.meta.noNextRun') }}
        </span>
        <div class="desktop-automation-plan__actions absolute right-0 flex items-center gap-[2px] opacity-0 pointer-events-none">
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

.desktop-automation-plan__timing {
  transition: opacity 120ms ease;
}

.desktop-automation-plan__actions {
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
