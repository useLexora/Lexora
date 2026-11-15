<script setup lang="ts">
import type { ConversationArchiveItem } from '@buddy-shared/conversation/conversationArchiveApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { ArchiveDeleteResult } from './useTaskArchiveManager'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowUndo20Regular, Delete20Regular, MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NEmpty, NPopover, NTooltip } from 'naive-ui'
import { computed, h } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopRingSpinner from '@/shared/ui/loading/DesktopRingSpinner.vue'
import DesktopSpaceIcon from '../space/DesktopSpaceIcon.vue'

const props = defineProps<{
  items: readonly ConversationArchiveItem[]
  spaces: readonly LocalSpace[]
  results: readonly ArchiveDeleteResult[]
  disabled: boolean
  spaceActionBusy: { spaceId: string | null } | null
  language: BuddyLocale
}>()
const emit = defineEmits<{
  view: [id: string]
  restore: [item: ConversationArchiveItem]
  delete: [item: ConversationArchiveItem]
  deleteSpace: [spaceId: string | null, name: string]
}>()
const { t } = useBuddyI18n(() => props.language)
const dateFormat = computed(() => new Intl.DateTimeFormat(props.language, { dateStyle: 'medium', timeStyle: 'short' }))
const spaceActions = computed(() => [{
  key: 'delete',
  label: () => h('span', { class: 'text-danger' }, t('desktop.archive.clearSpace')),
  icon: () => h(DesktopIcon, { component: Delete20Regular, size: 16, class: 'text-danger' }),
  disabled: props.disabled,
}])
const groups = computed(() => {
  const spaces = new Map(props.spaces.map(space => [space.id, space]))
  const failures = new Map(props.results.filter(result => result.status === 'failed').map(result => [result.item.id, result.error]))
  const grouped = new Map<string | null, ConversationArchiveItem[]>()
  for (const item of props.items) {
    const items = grouped.get(item.spaceId) ?? []
    items.push(item)
    grouped.set(item.spaceId, items)
  }
  return [...grouped].map(([spaceId, items]) => {
    const space = spaceId ? spaces.get(spaceId) : undefined
    return {
      spaceId,
      space,
      name: space?.name ?? t(spaceId ? 'desktop.archive.unknownSpace' : 'desktop.archive.unbound'),
      rows: items.map(item => ({
        item,
        title: item.title || t('desktop.tasks.untitled'),
        date: dateFormat.value.format(new Date(item.archivedAt || item.updatedAt)),
        canRestore: !item.deletedAt && !item.deletionStatus,
        failed: item.deletionStatus === 'failed' || failures.has(item.id),
        failure: failures.get(item.id) || item.errorCode,
      })),
    }
  }).sort((a, b) => a.spaceId === null ? 1 : b.spaceId === null ? -1 : a.name.localeCompare(b.name, props.language))
})
</script>

<template>
  <NEmpty v-if="!items.length" class="py-12" :description="t('desktop.archive.empty')" />
  <div v-else class="desktop-task-archive-list min-w-0 flex flex-col gap-6 [container-type:inline-size]">
    <section v-for="group in groups" :key="group.spaceId ?? ''" :data-archive-space="group.spaceId ?? ''" :aria-label="group.name" class="min-w-0">
      <header class="mb-2 min-h-7 flex items-center justify-between gap-3">
        <div class="min-w-0 flex items-center gap-2 text-muted">
          <DesktopSpaceIcon v-if="group.spaceId" :icon="group.space?.icon" :icon-color="group.space?.iconColor" :size="16" class="shrink-0" />
          <h3 class="m-0 break-words text-sm font-medium">
            {{ group.name }}
          </h3>
        </div>
        <NDropdown v-if="!group.spaceId || group.space" trigger="click" placement="bottom-end" :options="spaceActions" @select="!disabled && emit('deleteSpace', group.spaceId, group.name)">
          <NTooltip>
            <template #trigger>
              <NButton class="buddy-icon-button shrink-0" size="small" quaternary :disabled="disabled" :aria-busy="spaceActionBusy?.spaceId === group.spaceId ? true : undefined" :aria-label="t('desktop.archive.spaceActions', { space: group.name })" data-testid="task-archive-space-actions">
                <DesktopRingSpinner v-if="spaceActionBusy?.spaceId === group.spaceId" />
                <DesktopIcon v-else :component="MoreHorizontal20Regular" :size="18" />
              </NButton>
            </template>
            {{ t('desktop.archive.spaceActions', { space: group.name }) }}
          </NTooltip>
        </NDropdown>
      </header>
      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        <li v-for="{ item, title, date, canRestore, failed, failure } in group.rows" :key="item.id" class="desktop-task-archive-list__row min-w-0 border border-border rounded-control border-solid bg-surface px-4 py-3" :data-archive-id="item.id">
          <div class="min-w-0 flex flex-col gap-1">
            <div class="min-w-0 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <button v-if="canRestore" type="button" class="ui-focus-ring min-w-0 cursor-pointer border-0 rounded-micro bg-transparent p-0 text-left text-sm font-medium leading-6 text-fg enabled:hover:text-accent-text disabled:cursor-not-allowed disabled:text-disabled" :disabled="disabled" @click="emit('view', item.id)">
                <span class="line-clamp-2 break-words">{{ title }}</span>
              </button>
              <span v-else class="line-clamp-2 break-words text-sm font-medium leading-6 text-fg">{{ title }}</span>
              <NPopover v-if="failed" trigger="click" placement="bottom-start">
                <template #trigger>
                  <button type="button" class="ui-focus-ring shrink-0 cursor-pointer border-0 rounded-micro bg-transparent p-0 text-xs text-danger underline decoration-dotted underline-offset-4" data-delete-result="failed">
                    {{ t('desktop.archive.failed') }}
                  </button>
                </template>
                <div class="max-w-64 break-words text-sm">
                  <p class="m-0">
                    {{ t('desktop.archive.failureHint') }}
                  </p>
                  <p v-if="failure" class="mb-0 mt-2 text-xs text-muted">
                    {{ failure }}
                  </p>
                </div>
              </NPopover>
              <span v-else-if="item.deletionStatus === 'pending'" class="shrink-0 text-xs text-muted">{{ t('desktop.archive.pending') }}</span>
            </div>
            <time class="text-xs leading-relaxed text-muted" :datetime="item.archivedAt || item.updatedAt">{{ date }}</time>
          </div>
          <div class="desktop-task-archive-list__actions flex items-center justify-end gap-1">
            <NTooltip v-if="canRestore">
              <template #trigger>
                <NButton class="buddy-icon-button" size="small" quaternary :disabled="disabled" :aria-label="t('desktop.archive.restore')" @click="emit('restore', item)">
                  <DesktopIcon :component="ArrowUndo20Regular" :size="18" />
                </NButton>
              </template>
              {{ t('desktop.archive.restore') }}
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <NButton class="buddy-icon-button" size="small" type="error" quaternary :color="disabled || item.deletionStatus === 'pending' ? undefined : 'var(--buddy-status-danger-text)'" :disabled="disabled || item.deletionStatus === 'pending'" :aria-label="t('common.delete')" @click="emit('delete', item)">
                  <DesktopIcon :component="Delete20Regular" :size="18" />
                </NButton>
              </template>
              {{ t('common.delete') }}
            </NTooltip>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped lang="scss">
.desktop-task-archive-list__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;

  @container (max-width: 320px) {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }
}
</style>
