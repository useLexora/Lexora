<script setup lang="ts">
import type { LocalUsageTopTasks } from '@buddy-shared/usage/usageAnalyticsApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowUpRight20Regular } from '@vicons/fluent'
import { NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPaneBoundary from '@/shared/ui/loading/DesktopPaneBoundary.vue'
import { formatUsageNumber } from '../../model/usageAnalytics'

const props = defineProps<{
  tasks: LocalUsageTopTasks | null
  loading: boolean
  error: string | null
  language: BuddyLocale
}>()
const emit = defineEmits<{ openTask: [id: string], retry: [] }>()
const { t } = useBuddyI18n(() => props.language)
const numberFormat = computed(() => new Intl.NumberFormat(props.language))
const rows = computed(() => {
  const peak = props.tasks?.[0]?.totalTokens ?? 0
  return (props.tasks ?? []).map(task => ({ ...task, width: peak ? task.totalTokens / peak * 100 : 0 }))
})
</script>

<template>
  <section class="usage-tasks flex min-w-0 flex-col border-1 border-solid border-border rounded-[8px] p-[18px]">
    <header class="usage-tasks__heading flex items-center justify-between mb-[8px]">
      <h3>{{ t('usageAnalytics.topTasks') }}</h3>
      <span>Top 5</span>
    </header>
    <DesktopPaneBoundary :loading="loading" :error="error" :label="t('desktop.loading.pane')" :retry-label="t('desktop.loading.retry')" @retry="emit('retry')">
      <ol v-if="rows.length" class="usage-tasks__list grid gap-[16px] mt-[12px] mr-0 mb-0 ml-0 p-0">
        <li v-for="(task, index) in rows" :key="task.conversationId" class="usage-tasks__row flex min-w-0 items-start gap-[12px]">
          <span class="usage-tasks__rank w-[16px] flex-none pt-[2px] text-muted">{{ String(index + 1).padStart(2, '0') }}</span>
          <div class="grid min-w-0 flex-1 gap-[6px]">
            <div class="flex min-w-0 items-center justify-between gap-[10px]">
              <NTooltip>
                <template #trigger>
                  <button type="button" class="usage-tasks__name flex overflow-hidden min-w-0 items-center gap-[4px] border-0 rounded-[3px] bg-transparent p-0 text-fg cursor-pointer text-[12px] text-left hover:text-accent-text focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]" @click="emit('openTask', task.conversationId)">
                    <span>{{ task.title || t('usageAnalytics.untitledTask') }}</span>
                    <DesktopIcon :component="ArrowUpRight20Regular" :size="13" />
                  </button>
                </template>
                {{ task.title || t('usageAnalytics.untitledTask') }}
              </NTooltip>
              <NTooltip>
                <template #trigger>
                  <strong class="usage-tasks__amount flex-none text-fg">{{ formatUsageNumber(task.totalTokens, language) }}</strong>
                </template>
                {{ numberFormat.format(task.totalTokens) }} tokens
              </NTooltip>
            </div>
            <div class="usage-tasks__bar h-[3px] overflow-hidden rounded-[2px] bg-subtle" aria-hidden="true">
              <span :style="{ width: `${task.width}%` }" />
            </div>
            <span class="overflow-hidden text-muted text-[10px] text-ellipsis whitespace-nowrap">{{ task.spaceName ? `${task.spaceName} · ` : '' }}{{ t('usageAnalytics.modelCalls', { count: numberFormat.format(task.recordCount) }) }}</span>
          </div>
        </li>
      </ol>
      <p v-else class="py-[40px] px-0 text-muted text-[12px] text-center">
        {{ t('usageAnalytics.noTasks') }}
      </p>
    </DesktopPaneBoundary>
  </section>
</template>

<style scoped lang="scss">
.usage-tasks__heading h3 { margin: 0; color: var(--buddy-text-strong); font-size: 14px; font-weight: 600; }
.usage-tasks__heading > span { border-radius: 4px; background: var(--buddy-accent-surface); padding: 2px 6px; color: var(--buddy-accent-on-surface); font-size: 10px; font-weight: 550; }
.usage-tasks :deep(.desktop-pane-boundary) { min-height: 160px; flex: 1; }
.usage-tasks__list { list-style: none; }
.usage-tasks__rank { font-size: 10px; font-variant-numeric: tabular-nums; }
.usage-tasks__row:first-child .usage-tasks__rank { color: var(--buddy-accent-text); }
.usage-tasks__name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-tasks__name :deep(.n-icon) { flex: none; color: var(--buddy-text-disabled); }
.usage-tasks__bar > span { display: block; height: 100%; border-radius: inherit; background: var(--buddy-accent-solid); opacity: .7; }
.usage-tasks__row:first-child .usage-tasks__bar > span { opacity: 1; }

.usage-tasks__amount { font-size: 12px; font-weight: 550; font-variant-numeric: tabular-nums; }
</style>
