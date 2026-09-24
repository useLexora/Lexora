<script setup lang="ts">
import type { ApplicationLogRecord } from '@buddy-shared/diagnostics/applicationLog'
import type { BuddyI18nKey, BuddyLocale } from '@/i18n/buddyI18n'
import { Dismiss20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { formatLogDuration, formatLogTime } from '../../model/applicationLogPresentation'

const props = defineProps<{ record: ApplicationLogRecord, language: BuddyLocale, exporting?: boolean }>()
const emit = defineEmits<{ close: [], exportDiagnostics: [] }>()
const { t } = useBuddyI18n(() => props.language)
const fields: Array<[keyof ApplicationLogRecord, BuddyI18nKey]> = [
  ['component', 'applicationLogs.component'],
  ['method', 'applicationLogs.method'],
  ['errorCode', 'applicationLogs.errorCode'],
  ['errorType', 'applicationLogs.errorType'],
  ['launchId', 'applicationLogs.launchId'],
  ['operationId', 'applicationLogs.operationId'],
  ['parentOperationId', 'applicationLogs.parentOperationId'],
  ['generation', 'applicationLogs.generation'],
  ['conversationId', 'applicationLogs.conversationId'],
  ['branchId', 'applicationLogs.branchId'],
  ['runId', 'applicationLogs.runId'],
  ['turnId', 'applicationLogs.turnId'],
  ['sessionId', 'applicationLogs.sessionId'],
  ['requestId', 'applicationLogs.requestId'],
  ['toolCallId', 'applicationLogs.toolCallId'],
  ['providerId', 'applicationLogs.providerId'],
  ['connectorId', 'applicationLogs.connectorId'],
  ['automationId', 'applicationLogs.automationId'],
  ['occurrenceId', 'applicationLogs.occurrenceId'],
  ['count', 'applicationLogs.count'],
  ['attempt', 'applicationLogs.attempt'],
]
const details = computed(() => fields.flatMap(([key, label]) => props.record[key] === undefined ? [] : [{ key, label: t(label), value: String(props.record[key]) }]))
const raw = computed(() => JSON.stringify(props.record, null, 2))
</script>

<template>
  <section class="log-details" :aria-label="t('applicationLogs.details')">
    <header class="log-details__header">
      <div><span>{{ t('applicationLogs.details') }}</span><h2>{{ record.event }}</h2></div>
      <NButton size="tiny" secondary :disabled="exporting" @click="emit('exportDiagnostics')">
        {{ t('applicationLogs.exportRelated') }}
      </NButton>
      <NButton size="tiny" quaternary :aria-label="t('applicationLogs.closeDetails')" @click="emit('close')">
        <template #icon>
          <DesktopIcon :component="Dismiss20Regular" />
        </template>
      </NButton>
    </header>
    <div class="log-details__body">
      <div class="log-details__meta">
        <time>{{ formatLogTime(record.timestamp, language, true) }}</time><span>{{ t(`applicationLogs.source.${record.scope}`) }}</span><span>v{{ record.appVersion }}</span><span>{{ formatLogDuration(record.durationMs) }}</span>
      </div>
      <pre v-if="record.error || record.message" class="log-details__message">{{ record.error?.stack || record.error?.message || record.message }}</pre>
      <dl class="log-details__fields">
        <div v-for="field in details" :key="field.key">
          <dt>{{ field.label }}</dt><dd>{{ field.value }}</dd>
        </div>
      </dl>
      <details class="log-details__raw">
        <summary>{{ t('applicationLogs.raw') }}</summary><pre>{{ raw }}</pre>
      </details>
    </div>
  </section>
</template>

<style scoped>
.log-details { display: flex; max-height: 45%; min-height: 10rem; flex: 0 1 19rem; flex-direction: column; border: 1px solid var(--buddy-border-subtle); border-radius: 0.45rem; overflow: hidden; }
.log-details__header { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--buddy-border-subtle); padding: 0.65rem 0.85rem; }
.log-details__header > div { display: flex; min-width: 0; align-items: baseline; gap: 0.8rem; }
.log-details__header span { flex: none; color: var(--buddy-text-muted); font-size: 0.65rem; }
.log-details__header h2 { overflow: hidden; margin: 0; color: var(--buddy-text-primary); font-family: var(--buddy-font-mono); font-size: 0.72rem; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.log-details__body { min-height: 0; padding: 0.85rem; overflow: auto; font-size: 0.68rem; }
.log-details__meta { display: flex; flex-wrap: wrap; gap: 0.45rem 1rem; color: var(--buddy-text-secondary); font-variant-numeric: tabular-nums; }
.log-details__fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.8rem 1.2rem; margin: 0.9rem 0; }
.log-details__fields > div { display: grid; min-width: 0; gap: 0.3rem; }
.log-details__fields dt { color: var(--buddy-text-muted); }
.log-details__fields dd { margin: 0; color: var(--buddy-text-primary); font-family: var(--buddy-font-mono); overflow-wrap: anywhere; user-select: text; }
.log-details__message, .log-details__raw pre { margin: 0.8rem 0; padding: 0.65rem; border-radius: 0.25rem; background: var(--buddy-surface-muted); color: var(--buddy-text-primary); font-family: var(--buddy-font-mono); font-size: 0.65rem; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.log-details__raw summary { color: var(--buddy-text-secondary); cursor: pointer; }
</style>
