<script setup lang="ts">
import type { CpuProfileRequest, PerformanceDiagnosticApi, ProcessRole } from '@buddy-shared/diagnostics/performanceDiagnostic'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Info16Regular } from '@vicons/fluent'
import { NButton, NModal, NPopover, NSpin, useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { usePerformanceDiagnostics } from '../../state/usePerformanceDiagnostics'

const props = defineProps<{ api: PerformanceDiagnosticApi, language: BuddyLocale, exporting: boolean }>()
const emit = defineEmits<{ close: [], export: [] }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { sample, rendererPid, profile, capturing, unavailable, reading, refresh, capture } = usePerformanceDiagnostics({
  snapshot: () => props.api.snapshot(),
  capture: request => props.api.capture(request),
})
const roleOrder: Record<ProcessRole, number> = { main: 0, runtime: 1, renderer: 2, gpu: 3, network: 4, sandbox: 5, utility: 6, other: 7 }
const processes = computed(() => (sample.value?.processes ?? []).map((item) => {
  const target = item.role === 'main' || item.role === 'runtime' ? item.role : item.role === 'renderer' && item.pid === rendererPid.value ? 'renderer' : null
  const request: CpuProfileRequest | null = target ? { target, pid: item.pid } : null
  return {
    ...item,
    request,
    label: t(item.role === 'renderer' && item.pid === rendererPid.value ? 'applicationLogs.performance.currentWindow' : `applicationLogs.performance.${item.role}`),
  }
}).sort((a, b) => roleOrder[a.role] - roleOrder[b.role]
  || Number(b.pid === rendererPid.value) - Number(a.pid === rendererPid.value)
  || a.createdAt - b.createdAt || a.pid - b.pid))
const activeProfile = computed(() => capturing.value ?? profile.value)
const activeLabel = computed(() => activeProfile.value ? t(activeProfile.value.target === 'renderer' ? 'applicationLogs.performance.currentWindow' : `applicationLogs.performance.${activeProfile.value.target}`) : '')

async function analyze(request: CpuProfileRequest): Promise<void> {
  try {
    await capture(request)
  }
  catch {
    message.error(t('applicationLogs.performance.failed'))
  }
}

function close(): void {
  if (!capturing.value)
    emit('close')
}
</script>

<template>
  <NModal show preset="card" class="performance-diagnostics" data-testid="performance-diagnostics" :title="t('applicationLogs.performance.title')" :style="{ width: 'min(760px, calc(100vw - 32px))' }" :closable="!capturing" :mask-closable="!capturing" :close-on-esc="!capturing" @close="close" @update:show="value => !value && close()">
    <div class="performance-diagnostics__content">
      <p class="performance-diagnostics__meta">
        {{ t('applicationLogs.performance.metrics') }}
      </p>
      <div v-if="unavailable" class="performance-diagnostics__unavailable" role="status">
        <span>{{ t('applicationLogs.performance.unavailable') }}</span>
        <NButton size="small" :loading="reading" @click="refresh">
          {{ t('desktop.loading.retry') }}
        </NButton>
      </div>
      <NSpin v-if="!sample && !unavailable" size="small" class="performance-diagnostics__loading" />
      <div v-if="sample" class="performance-diagnostics__processes">
        <table class="performance-diagnostics__table">
          <thead>
            <tr><th>{{ t('applicationLogs.performance.process') }}</th><th>PID</th><th>CPU</th><th>{{ t('applicationLogs.performance.memory') }}</th><th>{{ t('applicationLogs.performance.analysis') }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in processes" :key="`${item.pid}:${item.createdAt}`" :class="{ 'is-analyzing': capturing?.pid === item.pid }">
              <td>{{ item.label }}</td>
              <td class="performance-diagnostics__pid">
                {{ item.pid }}
              </td>
              <td>{{ item.cpuPercent === null ? '—' : `${item.cpuPercent.toFixed(1)}%` }}</td>
              <td>{{ (item.memoryKiB / 1024).toFixed(0) }} MiB</td>
              <td>
                <NButton v-if="item.request" size="small" secondary :loading="capturing?.pid === item.pid" :disabled="!!capturing" @click="analyze(item.request)">
                  {{ t(capturing?.pid === item.pid ? 'applicationLogs.performance.capturing' : 'applicationLogs.performance.capture') }}
                </NButton>
                <span v-else class="performance-diagnostics__meta">{{ t('applicationLogs.performance.metricsOnly') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="activeProfile" class="performance-diagnostics__result" :class="{ 'is-complete': !capturing && profile }" role="status">
        <NSpin v-if="capturing" size="small" />
        <div>
          <strong>{{ t(capturing ? 'applicationLogs.performance.progress' : 'applicationLogs.performance.completed', { process: activeLabel, pid: activeProfile.pid }) }}</strong>
          <p>{{ t(capturing ? 'applicationLogs.performance.wait' : 'applicationLogs.performance.saved') }}</p>
        </div>
      </div>
      <div class="performance-diagnostics__notes">
        <span>{{ t('applicationLogs.performance.privacy') }}</span>
        <NPopover trigger="click" placement="top-end" :width="320" :content-style="{ fontSize: '12px', lineHeight: '1.7' }">
          <template #trigger>
            <NButton text size="small" :theme-overrides="{ fontSizeSmall: '12px', iconSizeSmall: '14px' }">
              <template #icon>
                <DesktopIcon :component="Info16Regular" :size="14" />
              </template>
              {{ t('applicationLogs.performance.scope') }}
            </NButton>
          </template>
          {{ t('applicationLogs.performance.coverage') }}
        </NPopover>
      </div>
    </div>
    <template #footer>
      <div class="performance-diagnostics__footer">
        <NButton size="small" :disabled="!!capturing" @click="close">
          {{ t('common.close') }}
        </NButton>
        <NButton size="small" type="primary" :disabled="!!capturing || exporting" :loading="exporting" @click="emit('export')">
          {{ t('applicationLogs.exportDiagnostics') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.performance-diagnostics__content { max-height: calc(100vh - 220px); overflow: auto; color: var(--buddy-text-primary); font-size: 13px; line-height: 1.6; }
.performance-diagnostics__meta { color: var(--buddy-text-secondary); font-size: 12px; }
.performance-diagnostics__content > .performance-diagnostics__meta { margin: 0 0 14px; }
.performance-diagnostics__processes { overflow-x: auto; border: 1px solid var(--buddy-border-subtle); border-radius: 6px; }
.performance-diagnostics__table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.performance-diagnostics__table th { padding: 9px 12px; color: var(--buddy-text-secondary); font-weight: 500; }
.performance-diagnostics__table td { height: 48px; padding: 8px 12px; border-top: 1px solid var(--buddy-border-subtle); }
.performance-diagnostics__table th:first-child { width: 30%; }
.performance-diagnostics__table th:nth-child(3), .performance-diagnostics__table th:nth-child(4), .performance-diagnostics__table td:nth-child(3), .performance-diagnostics__table td:nth-child(4) { text-align: right; }
.performance-diagnostics__table th:last-child, .performance-diagnostics__table td:last-child { width: 112px; text-align: right; }
.performance-diagnostics__table .is-analyzing { background: var(--buddy-surface-subtle); }
.performance-diagnostics__pid { color: var(--buddy-text-secondary); }
.performance-diagnostics__result { display: flex; align-items: center; gap: 12px; margin-top: 16px; padding: 12px; border: 1px solid var(--buddy-border-subtle); border-radius: 6px; }
.performance-diagnostics__result strong { font-size: 13px; font-weight: 500; }
.performance-diagnostics__result p { margin: 4px 0 0; color: var(--buddy-text-secondary); font-size: 12px; }
.performance-diagnostics__result.is-complete { border-color: var(--buddy-status-success-solid); }
.performance-diagnostics__notes { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; margin-top: 16px; color: var(--buddy-text-secondary); font-size: 12px; }
.performance-diagnostics__footer { display: flex; justify-content: flex-end; gap: 8px; }
.performance-diagnostics__loading { display: block; padding: 32px; text-align: center; }
.performance-diagnostics__unavailable { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; }
</style>
