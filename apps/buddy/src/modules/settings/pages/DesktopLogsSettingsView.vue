<script setup lang="ts">
import type { ApplicationLogExport, ApplicationLogRecord } from '@buddy-shared/diagnostics/applicationLog'
import { useDialog, useMessage } from 'naive-ui'
import { h, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import DesktopSettingsModuleLayout from '../layouts/DesktopSettingsModuleLayout.vue'
import { useSettingsContext } from '../settingsContext'
import { useApplicationLogs } from '../state/useApplicationLogs'
import DesktopApplicationLogActions from '../widgets/application-logs/DesktopApplicationLogActions.vue'
import DesktopApplicationLogs from '../widgets/application-logs/DesktopApplicationLogs.vue'
import DesktopDiagnosticExportSummary from '../widgets/application-logs/DesktopDiagnosticExportSummary.vue'
import DesktopPerformanceDiagnostics from '../widgets/application-logs/DesktopPerformanceDiagnostics.vue'

const { applicationSettings } = useSettingsContext()
const { language } = applicationSettings
const api = requireDesktopApi().app
const logs = useApplicationLogs(api.logs)
const { t } = useBuddyI18n(language)
const message = useMessage()
const dialog = useDialog()
const performanceOpen = shallowRef(false)

async function saveDiagnostics(input: ApplicationLogExport): Promise<void> {
  try {
    const result = await logs.exportDiagnostics(input)
    if (result.status === 'saved')
      message.success(t('applicationLogs.exportSucceeded', { count: result.errorCount, context: result.contextCount }))
    else if (result.status === 'empty')
      message.info(t('applicationLogs.exportEmpty'))
  }
  catch {
    message.error(t('applicationLogs.exportFailed'))
  }
}

function confirmExport(record?: ApplicationLogRecord, launch = logs.launch.value): void {
  const input: ApplicationLogExport = record ? { launch: record.launchId, anchor: { launchId: record.launchId, sequence: record.sequence } } : { launch }
  performanceOpen.value = false
  dialog.create({
    title: t('applicationLogs.exportDiagnostics'),
    showIcon: false,
    style: { width: 'min(480px, calc(100vw - 32px))' },
    content: () => h(DesktopDiagnosticExportSummary, { language: language.value, selected: !!record }),
    positiveText: t('applicationLogs.exportSave'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => saveDiagnostics(input),
  })
}
</script>

<template>
  <DesktopSettingsModuleLayout>
    <template #actions>
      <DesktopApplicationLogActions :live="logs.live.value" :exporting="logs.exporting.value" :language="language" @update:live="$event ? logs.follow() : logs.pause()" @performance="performanceOpen = true" @export="confirmExport()" />
    </template>
    <DesktopApplicationLogs
      :logs="logs" :language="language"
      @update:launch="logs.launch.value = $event" @update:category="logs.category.value = $event"
      @update:level="logs.level.value = $event" @update:search="logs.search.value = $event"
      @close-details="logs.selected.value = null" @export="confirmExport($event)"
    />
  </DesktopSettingsModuleLayout>
  <DesktopPerformanceDiagnostics v-if="performanceOpen" :api="api.performance" :language="language" :exporting="logs.exporting.value" @close="performanceOpen = false" @export="confirmExport(undefined, 'current')" />
</template>
