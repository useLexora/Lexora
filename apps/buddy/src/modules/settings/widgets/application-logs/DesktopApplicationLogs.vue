<script setup lang="ts">
import type { ApplicationLogApi } from '@buddy-shared/diagnostics/applicationLog'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NPagination, useDialog, useMessage } from 'naive-ui'
import { h } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopPaneBoundary from '@/shared/ui/loading/DesktopPaneBoundary.vue'
import { useApplicationLogs } from '../../state/useApplicationLogs'
import DesktopApplicationLogDetails from './DesktopApplicationLogDetails.vue'
import DesktopApplicationLogFilters from './DesktopApplicationLogFilters.vue'
import DesktopApplicationLogList from './DesktopApplicationLogList.vue'
import DesktopDiagnosticExportSummary from './DesktopDiagnosticExportSummary.vue'

const props = defineProps<{ api: ApplicationLogApi, language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const dialog = useDialog()
const { launch, category, level, search, live, page, selected, loading, failed, exporting, viewKey, refresh, pause, changePage, follow, select, exportDiagnostics } = useApplicationLogs({
  query: input => props.api.query(input),
  exportDiagnostics: input => props.api.exportDiagnostics(input),
})

async function saveDiagnostics(): Promise<void> {
  try {
    const result = await exportDiagnostics()
    if (result.status === 'saved')
      message.success(t('applicationLogs.exportSucceeded', { count: result.errorCount }))
    else if (result.status === 'empty')
      message.info(t('applicationLogs.exportEmpty'))
  }
  catch {
    message.error(t('applicationLogs.exportFailed'))
  }
}

function confirmExport(): void {
  dialog.create({
    title: t('applicationLogs.exportDiagnostics'),
    showIcon: false,
    style: { width: 'min(480px, calc(100vw - 32px))' },
    content: () => h(DesktopDiagnosticExportSummary, { language: props.language }),
    positiveText: t('applicationLogs.exportSave'),
    negativeText: t('common.cancel'),
    onPositiveClick: saveDiagnostics,
  })
}
</script>

<template>
  <div class="application-logs">
    <DesktopApplicationLogFilters v-model:launch="launch" v-model:category="category" v-model:level="level" v-model:search="search" :language="language" :launches="page?.launches ?? []" :current-launch-id="page?.currentLaunchId" :live="live" :loading="loading" :exporting="exporting" @refresh="refresh" @toggle-live="live ? pause() : follow()" @export-diagnostics="confirmExport" />
    <DesktopPaneBoundary :loading="!page && loading" :error="!page && failed ? t('applicationLogs.readFailed') : null" :label="t('desktop.loading.pane')" :retry-label="t('desktop.loading.retry')" @retry="refresh">
      <DesktopApplicationLogList :key="viewKey" :records="page?.records ?? []" :selected="selected" :language="language" @select="select" @pause="pause" />
    </DesktopPaneBoundary>
    <DesktopApplicationLogDetails v-if="selected" :record="selected" :language="language" @close="selected = null" />
    <footer class="application-logs__footer">
      <div class="application-logs__status">
        <span class="application-logs__indicator" :class="{ 'is-live': live }" aria-hidden="true" />
        <span>{{ t(live ? 'applicationLogs.live' : 'applicationLogs.paused') }}</span>
      </div>
      <div class="application-logs__pagination">
        <NButton v-if="page?.anchorExpired" size="tiny" secondary @click="follow">
          {{ t('applicationLogs.expired') }}
        </NButton>
        <NPagination v-else simple size="small" :page="page?.page ?? 1" :page-count="Math.max(1, Math.ceil((page?.total ?? 0) / (page?.pageSize ?? 100)))" :disabled="loading || !page?.total" @update:page="changePage">
          <template #prefix>
            <span class="application-logs__total">{{ t('applicationLogs.total', { count: page?.total ?? 0 }) }}</span>
          </template>
        </NPagination>
      </div>
    </footer>
    <div v-if="page && failed" class="application-logs__notice" role="status">
      {{ t('applicationLogs.readFailed') }}
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
