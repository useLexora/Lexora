<script setup lang="ts">
import type { ApplicationLogQuery, ApplicationLogRecord } from '@buddy-shared/diagnostics/applicationLog'
import type { useApplicationLogs } from '../../state/useApplicationLogs'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NPagination } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopPaneBoundary from '@/shared/ui/loading/DesktopPaneBoundary.vue'
import DesktopApplicationLogDetails from './DesktopApplicationLogDetails.vue'
import DesktopApplicationLogFilters from './DesktopApplicationLogFilters.vue'
import DesktopApplicationLogList from './DesktopApplicationLogList.vue'

const props = defineProps<{ logs: ReturnType<typeof useApplicationLogs>, language: BuddyLocale }>()
const emit = defineEmits<{
  'export': [record: ApplicationLogRecord]
  'closeDetails': []
  'update:launch': [value: string]
  'update:category': [value: NonNullable<ApplicationLogQuery['category']>]
  'update:level': [value: NonNullable<ApplicationLogQuery['level']>]
  'update:search': [value: string]
}>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="application-logs">
    <DesktopApplicationLogFilters :launch="logs.launch.value" :category="logs.category.value" :level="logs.level.value" :search="logs.search.value" :language="language" :launches="logs.page.value?.launches ?? []" :current-launch-id="logs.page.value?.currentLaunchId" @update:launch="emit('update:launch', $event)" @update:category="emit('update:category', $event)" @update:level="emit('update:level', $event)" @update:search="emit('update:search', $event)" />
    <DesktopPaneBoundary :loading="!logs.page.value && logs.loading.value" :error="!logs.page.value && logs.failed.value ? t('applicationLogs.readFailed') : null" :label="t('desktop.loading.pane')" :retry-label="t('desktop.loading.retry')" @retry="logs.refresh">
      <DesktopApplicationLogList :key="logs.viewKey.value" :records="logs.page.value?.records ?? []" :selected="logs.selected.value" :language="language" @select="logs.select" @pause="logs.pause" />
    </DesktopPaneBoundary>
    <DesktopApplicationLogDetails v-if="logs.selected.value" :record="logs.selected.value" :language="language" :exporting="logs.exporting.value" @close="emit('closeDetails')" @export-diagnostics="emit('export', logs.selected.value)" />
    <footer class="application-logs__footer">
      <div class="application-logs__status">
        <span class="application-logs__indicator" :class="{ 'is-live': logs.live.value }" aria-hidden="true" />
        <span>{{ t(logs.live.value ? 'applicationLogs.live' : 'applicationLogs.paused') }}</span>
      </div>
      <div class="application-logs__pagination">
        <NButton v-if="logs.page.value?.anchorExpired" size="tiny" secondary @click="logs.follow">
          {{ t('applicationLogs.expired') }}
        </NButton>
        <NPagination v-else simple size="small" :page="logs.page.value?.page ?? 1" :page-count="Math.max(1, Math.ceil((logs.page.value?.total ?? 0) / (logs.page.value?.pageSize ?? 100)))" :disabled="logs.loading.value || !logs.page.value?.total" @update:page="logs.changePage">
          <template #prefix>
            <span class="application-logs__total">{{ t('applicationLogs.total', { count: logs.page.value?.total ?? 0 }) }}</span>
          </template>
        </NPagination>
      </div>
    </footer>
    <div v-if="logs.page.value && logs.failed.value" class="application-logs__notice" role="status">
      {{ t('applicationLogs.readFailed') }}
      <NButton size="tiny" text @click="logs.refresh">
        {{ t('desktop.loading.retry') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.application-logs { display: flex; width: 100%; min-width: 0; min-height: 0; flex: 1; flex-direction: column; gap: 0.8rem; padding: 1.15rem 1.1rem 0.45rem; }
.application-logs__footer { display: flex; min-height: 1.9rem; flex: none; align-items: center; justify-content: space-between; gap: 0.5rem; color: var(--buddy-text-secondary); font-size: 0.65rem; }
.application-logs__status, .application-logs__pagination { display: flex; align-items: center; gap: 0.45rem; }
.application-logs__indicator { width: 5px; height: 5px; border-radius: 50%; background: var(--buddy-text-muted); }
.application-logs__indicator.is-live { background: var(--buddy-status-success-solid); box-shadow: 0 0 0 3px var(--buddy-status-success-surface); }
.application-logs__total { color: var(--buddy-text-secondary); font-size: 0.65rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.application-logs__notice { flex: none; padding-bottom: 0.4rem; color: var(--buddy-status-warning-text); font-size: 0.65rem; }
</style>
