<script setup lang="ts">
import type { LocalAutomationOccurrencePage } from '@buddy-shared/automation/automationApi'

import type { DropdownOption } from 'naive-ui'
import type { Component } from 'vue'
import type { AutomationHistoryStatusIcon } from '../../model/automationPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import {
  ApprovalsApp20Regular,
  Checkmark20Regular,
  ChevronDown20Regular,
  ChevronRight20Regular,
  ErrorCircle20Regular,
  MoreHorizontal20Regular,
  SpinnerIos20Regular,
  SubtractCircle20Regular,
} from '@vicons/fluent'
import { NButton, NDropdown, NEmpty, NModal } from 'naive-ui'
import { computed, h, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import {
  automationEffectiveStatusKey,
  automationHistoryStatusIcon,
} from '../../model/automationPresentation'

type AutomationOccurrenceView = LocalAutomationOccurrencePage['items'][number]

const props = defineProps<{
  busy: boolean
  language: BuddyLocale
  occurrences: LocalAutomationOccurrencePage['items']
}>()
const emit = defineEmits<{
  delete: [occurrence: AutomationOccurrenceView]
  openTask: [conversationId: string]
}>()
const { t } = useBuddyI18n(() => props.language)
const collapsedGroupKeys = shallowRef<ReadonlySet<string>>(new Set())
const deleteTarget = shallowRef<AutomationOccurrenceView | null>(null)
const statusIconComponents = {
  approval: ApprovalsApp20Regular,
  completed: Checkmark20Regular,
  failed: ErrorCircle20Regular,
  loading: SpinnerIos20Regular,
  neutral: SubtractCircle20Regular,
} satisfies Record<AutomationHistoryStatusIcon, Component>
const groups = computed(() => {
  const grouped = new Map<string, AutomationOccurrenceView[]>()
  for (const occurrence of props.occurrences) {
    const key = localDateKey(occurrenceTime(occurrence))
    const items = grouped.get(key) ?? []
    items.push(occurrence)
    grouped.set(key, items)
  }
  return [...grouped].map(([key, items]) => ({
    items,
    key,
    label: formatDateGroup(key),
  }))
})
const actionOptions = computed<DropdownOption[]>(() => [{
  icon: () => h(DesktopIcon, { name: 'delete' }),
  key: 'delete',
  label: t('desktop.automations.action.delete'),
}])
const deleteMessage = computed(() => t('desktop.automations.history.deleteMessage', {
  name: deleteTarget.value?.automationName ?? '',
}))

function occurrenceTime(occurrence: AutomationOccurrenceView): Date {
  return new Date(
    occurrence.run?.completedAt
    ?? occurrence.run?.startedAt
    ?? occurrence.finishedAt
    ?? occurrence.scheduledFor,
  )
}

function localDateKey(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
}

function formatDateGroup(key: string): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (key === localDateKey(today))
    return t('desktop.automations.history.today')
  if (key === localDateKey(yesterday))
    return t('desktop.automations.history.yesterday')
  return new Intl.DateTimeFormat(props.language, {
    dateStyle: 'medium',
  }).format(new Date(`${key}T00:00:00`))
}

function formatTime(occurrence: AutomationOccurrenceView): string {
  return new Intl.DateTimeFormat(props.language, {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
  }).format(occurrenceTime(occurrence))
}

function openOccurrence(occurrence: AutomationOccurrenceView): void {
  if (occurrence.conversationId)
    emit('openTask', occurrence.conversationId)
}

function isGroupCollapsed(key: string): boolean {
  return collapsedGroupKeys.value.has(key)
}

function toggleGroup(key: string): void {
  const next = new Set(collapsedGroupKeys.value)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  collapsedGroupKeys.value = next
}

function statusIconComponent(
  status: AutomationOccurrenceView['effectiveStatus'],
): Component {
  return statusIconComponents[automationHistoryStatusIcon(status)]
}

function handleAction(occurrence: AutomationOccurrenceView, action: string | number): void {
  if (action === 'delete')
    deleteTarget.value = occurrence
}

function confirmDelete(): void {
  if (!deleteTarget.value)
    return
  emit('delete', deleteTarget.value)
  deleteTarget.value = null
}
</script>

<template>
  <div v-if="groups.length" class="desktop-automation-history-list">
    <section
      v-for="group in groups"
      :key="group.key"
      class="desktop-automation-history-group"
    >
      <h2 class="desktop-automation-history-group__heading">
        <button
          class="desktop-automation-history-group__toggle"
          type="button"
          :aria-controls="`automation-history-group-${group.key}`"
          :aria-expanded="!isGroupCollapsed(group.key)"
          @click="toggleGroup(group.key)"
        >
          <span>{{ group.label }}</span>
          <DesktopIcon
            aria-hidden="true"
            :component="isGroupCollapsed(group.key) ? ChevronRight20Regular : ChevronDown20Regular"
          />
        </button>
      </h2>
      <div
        v-show="!isGroupCollapsed(group.key)"
        :id="`automation-history-group-${group.key}`"
        class="desktop-automation-history-group__items"
      >
        <article
          v-for="occurrence in group.items"
          :key="occurrence.id"
          class="desktop-automation-history-item"
        >
          <component
            :is="occurrence.conversationId ? 'button' : 'div'"
            class="desktop-automation-history-item__body"
            :class="{ 'is-clickable': occurrence.conversationId }"
            :type="occurrence.conversationId ? 'button' : undefined"
            @click="openOccurrence(occurrence)"
          >
            <span class="desktop-automation-history-item__content">
              <strong>{{ occurrence.automationName }}</strong>
              <span>{{ t(automationEffectiveStatusKey(occurrence)) }}</span>
            </span>
          </component>
          <div class="desktop-automation-history-item__trailing">
            <time :datetime="occurrenceTime(occurrence).toISOString()">
              {{ formatTime(occurrence) }}
            </time>
            <DesktopIcon
              aria-hidden="true"
              class="desktop-automation-history-item__result-icon"
              :class="`is-${automationHistoryStatusIcon(occurrence.effectiveStatus)}`"
              :component="statusIconComponent(occurrence.effectiveStatus)"
            />
            <div class="desktop-automation-history-item__actions">
              <NDropdown
                trigger="click"
                :options="actionOptions"
                @select="handleAction(occurrence, $event)"
              >
                <NButton
                  quaternary
                  circle
                  size="small"
                  :aria-label="t('desktop.automations.action.more')"
                  :disabled="busy"
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
    </section>
  </div>

  <NEmpty v-else class="desktop-automation-history-list__empty">
    <template #default>
      <strong>{{ t('desktop.automations.historyEmpty') }}</strong>
      <p>{{ t('desktop.automations.historyEmptyDescription') }}</p>
    </template>
  </NEmpty>

  <NModal
    :show="deleteTarget !== null"
    preset="dialog"
    type="warning"
    :title="t('desktop.automations.history.deleteTitle')"
    @update:show="!$event && (deleteTarget = null)"
  >
    {{ deleteMessage }}
    <template #action>
      <NButton @click="deleteTarget = null">
        {{ t('desktop.automations.editor.cancel') }}
      </NButton>
      <NButton type="error" :loading="busy" @click="confirmDelete">
        {{ t('desktop.automations.action.delete') }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-automation-history-list {
  display: grid;
  gap: 14px;
}

.desktop-automation-history-group {
  display: grid;
  gap: 2px;
}

.desktop-automation-history-group__heading {
  margin: 0;
}

.desktop-automation-history-group__toggle {
  display: flex;
  width: 100%;
  min-height: 28px;
  align-items: center;
  gap: 4px;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: transparent;
  color: var(--buddy-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 12px;
  text-align: left;

  &:hover {
    color: var(--buddy-text-secondary);
  }

  &:focus-visible {
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }

  .n-icon {
    font-size: 14px;
  }
}

.desktop-automation-history-group__items {
  display: grid;
  gap: 2px;
}

.desktop-automation-history-item {
  display: grid;
  width: 100%;
  min-height: 46px;
  box-sizing: border-box;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: transparent;
  color: inherit;

  &:hover,
  &:focus-within {
    background: var(--buddy-surface-subtle);
  }
}

.desktop-automation-history-item__body {
  display: flex;
  min-width: 0;
  min-height: 46px;
  align-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0 12px;
  text-align: left;

  &.is-clickable {
    cursor: pointer;
  }

  &:focus-visible {
    border-radius: var(--n-border-radius, 3px);
    outline: 2px solid var(--buddy-focus-ring);
    outline-offset: -2px;
  }
}

.desktop-automation-history-item__content {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 9px;

  strong {
    overflow: hidden;
    color: var(--buddy-text-strong);
    font-size: 14px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    flex: none;
    color: var(--buddy-text-secondary);
    font-size: 12px;
  }
}

.desktop-automation-history-item__trailing time,
.desktop-automation-history-item__result-icon {
  color: var(--buddy-text-muted);
}

.desktop-automation-history-item__trailing {
  position: relative;
  display: grid;
  min-width: 82px;
  min-height: 34px;
  grid-template-columns: auto 18px;
  align-items: center;
  gap: 10px;
  padding-right: 12px;
}

.desktop-automation-history-item__trailing time {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.desktop-automation-history-item__actions {
  position: absolute;
  right: 8px;
  opacity: 0;
  pointer-events: none;
}

.desktop-automation-history-item:hover .desktop-automation-history-item__result-icon,
.desktop-automation-history-item:focus-within .desktop-automation-history-item__result-icon {
  opacity: 0;
}

.desktop-automation-history-item:hover .desktop-automation-history-item__actions,
.desktop-automation-history-item:focus-within .desktop-automation-history-item__actions {
  opacity: 1;
  pointer-events: auto;
}

.desktop-automation-history-item__result-icon {
  font-size: 16px;

  &.is-loading {
    animation: desktop-automation-history-spin 1s linear infinite;
  }

  &.is-approval {
    color: var(--buddy-status-warning-text);
  }

  &.is-completed {
    color: var(--buddy-status-success-text);
  }

  &.is-failed {
    color: var(--buddy-status-danger-text);
  }
}

@keyframes desktop-automation-history-spin {
  to {
    transform: rotate(360deg);
  }
}

.desktop-automation-history-list__empty {
  min-height: 360px;
  margin: 0;
  padding-top: clamp(72px, 14vh, 132px);

  :deep(.n-empty__description) {
    display: grid;
    max-width: 420px;
    justify-items: center;
    gap: 8px;
    text-align: center;
  }

  strong {
    color: var(--buddy-text-strong);
    font-size: 16px;
  }

  p {
    margin: 0;
    line-height: 1.6;
  }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-automation-history-item__result-icon.is-loading {
    animation: none;
  }
}
</style>
