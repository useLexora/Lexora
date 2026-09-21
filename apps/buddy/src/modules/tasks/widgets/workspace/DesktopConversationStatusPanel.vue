<script setup lang="ts">
import type { LocalConversationStatus } from '@buddy-shared/runs/conversationStatusApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowSync20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopConversationStatusSection from './DesktopConversationStatusSection.vue'

const props = defineProps<{
  currentModelId: string | null
  isLoading: boolean
  language: BuddyLocale
  loadFailed: boolean
  status: LocalConversationStatus | null
}>()
const emit = defineEmits<{ refresh: [] }>()
const { t } = useBuddyI18n(() => props.language)

function formatTokens(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000)
    return `${(value / 1_000).toFixed(1)}k`
  return `${value}`
}

function formatDuration(ms: number): string {
  if (ms < 1_000)
    return `${Math.round(ms)}ms`
  const seconds = ms / 1_000
  if (seconds < 60)
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const minutes = seconds / 60
  if (minutes < 60)
    return `${Math.round(minutes)}m`
  return `${Math.floor(minutes / 60)}h${Math.round(minutes % 60)}m`
}

function formatCost(value: number): string {
  if (value <= 0)
    return ''
  return `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`
}

function formatRate(value: number): string {
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} tok/s`
}

function modelLabel(providerId: string, modelId: string): string {
  return modelId || providerId
}

const cacheHitRate = computed(() => {
  const totals = props.status?.tokens.totals
  if (!totals)
    return null
  const reads = totals.cacheReadTokens + totals.inputTokens
  return reads > 0 ? `${Math.round((totals.cacheReadTokens / reads) * 100)}%` : null
})
const runRows = computed(() => {
  const runs = props.status?.activity.runs
  if (!runs)
    return []
  return [
    { key: 'chat', label: t('desktop.chat.status.runsChat'), value: runs.chat },
    { key: 'compaction', label: t('desktop.chat.status.runsCompaction'), value: runs.compaction },
    { key: 'automation', label: t('desktop.chat.status.runsAutomation'), value: runs.automation },
  ].filter(entry => entry.value.total > 0)
})
</script>

<template>
  <div class="conversation-status">
    <header class="conversation-status__header">
      <h2 class="conversation-status__title">
        {{ t('desktop.chat.status.title') }}
      </h2>
      <NButton
        quaternary
        size="tiny"
        :loading="isLoading"
        :disabled="isLoading"
        @mousedown.prevent
        @click="emit('refresh')"
      >
        <template #icon>
          <DesktopIcon :component="ArrowSync20Regular" />
        </template>
        {{ t('desktop.chat.status.refresh') }}
      </NButton>
    </header>

    <div class="conversation-status__body" :aria-busy="isLoading">
      <span v-if="loadFailed" class="conversation-status__empty">{{ t('desktop.chat.status.loadFailed') }}</span>
      <span v-else-if="isLoading && !status" class="conversation-status__empty">{{ t('desktop.chat.status.loading') }}</span>
      <span v-else-if="!status" class="conversation-status__empty">{{ t('desktop.chat.status.empty') }}</span>
      <template v-else>
        <p v-if="!status.activity.turns && !runRows.length && !status.activity.tools.total && !status.activity.compactions.count && !status.tokens.totals.totalTokens" class="conversation-status__empty">
          {{ t('desktop.chat.status.empty') }}
        </p>

        <DesktopConversationStatusSection
          v-if="status.activity.turns || runRows.length || status.activity.tools.total || status.activity.compactions.count"
          :title="t('desktop.chat.status.activity')"
        >
          <div v-if="status.activity.turns" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.turns') }}</span><span>{{ status.activity.turns }}</span>
          </div>
          <div v-for="entry in runRows" :key="entry.key" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.runs') }} · {{ entry.label }}</span>
            <span class="conversation-status__values">
              <span>{{ t('desktop.chat.status.succeededCount', { count: entry.value.succeeded }) }}</span>
              <span v-if="entry.value.cancelled">{{ t('desktop.chat.status.cancelledCount', { count: entry.value.cancelled }) }}</span>
              <span v-if="entry.value.running" class="conversation-status__badge is-active">{{ t('desktop.chat.status.runningCount', { count: entry.value.running }) }}</span>
            </span>
          </div>
          <div v-if="status.activity.tools.total" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.tools') }}</span>
            <span class="conversation-status__values">
              <span>{{ t('desktop.chat.status.toolCount', { count: status.activity.tools.total }) }}</span>
              <span v-if="status.activity.tools.denied" class="conversation-status__badge is-warning">{{ t('desktop.chat.status.deniedCount', { count: status.activity.tools.denied }) }}</span>
              <span v-if="status.activity.tools.running" class="conversation-status__badge is-active">{{ t('desktop.chat.status.runningCount', { count: status.activity.tools.running }) }}</span>
            </span>
          </div>
          <div v-if="status.activity.tools.top.length" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.toolsTop') }}</span>
            <span class="conversation-status__values">
              <span v-for="entry in status.activity.tools.top" :key="entry.name">{{ entry.name }} × {{ entry.count }}</span>
            </span>
          </div>
          <div v-if="status.activity.compactions.count" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.compactions') }}</span>
            <span>{{ t('desktop.chat.status.compactionsValue', {
              after: formatTokens(status.activity.compactions.lastAfterTokens ?? 0),
              before: formatTokens(status.activity.compactions.lastBeforeTokens ?? 0),
              count: status.activity.compactions.count,
            }) }}</span>
          </div>
        </DesktopConversationStatusSection>

        <DesktopConversationStatusSection
          v-if="status.timing.wallMs || status.timing.modelMs || status.timing.toolMs || status.timing.ttft.samples || status.timing.throughput.samples"
          :title="t('desktop.chat.status.timing')"
        >
          <div v-if="status.timing.wallMs" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.wall') }}</span><span>{{ formatDuration(status.timing.wallMs) }}</span>
          </div>
          <div v-if="status.timing.modelMs" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.model') }}</span><span>{{ formatDuration(status.timing.modelMs) }}</span>
          </div>
          <div v-if="status.timing.toolMs" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.tools_time') }}</span><span>{{ formatDuration(status.timing.toolMs) }}</span>
          </div>
          <div v-if="status.timing.ttft.samples" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.ttft') }}</span>
            <span>{{ t('desktop.chat.status.averageDuration', { duration: formatDuration(status.timing.ttft.averageMs) }) }} · {{ t('desktop.chat.status.maxDuration', { duration: formatDuration(status.timing.ttft.maxMs) }) }}</span>
          </div>
          <div v-if="status.timing.throughput.samples && status.timing.throughput.tokensPerSecond" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.throughput') }}</span>
            <span>{{ formatRate(status.timing.throughput.tokensPerSecond) }} {{ t('desktop.chat.status.samples', { count: status.timing.throughput.samples }) }}</span>
          </div>
          <div v-if="status.timing.slowestTools.length" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.slowestTools') }}</span>
            <span class="conversation-status__values">
              <span v-for="(entry, index) in status.timing.slowestTools" :key="index">{{ entry.name }} {{ formatDuration(entry.ms) }}</span>
            </span>
          </div>
        </DesktopConversationStatusSection>

        <DesktopConversationStatusSection v-if="status.tokens.totals.totalTokens || status.tokens.byModel.length" :title="t('desktop.chat.status.tokens')">
          <div v-if="status.tokens.totals.totalTokens" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.totalTokens') }}</span><span>{{ formatTokens(status.tokens.totals.totalTokens) }}</span>
          </div>
          <div v-if="cacheHitRate" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.cacheHit') }}</span><span>{{ cacheHitRate }}</span>
          </div>
          <div v-if="formatCost(status.tokens.totals.totalCost)" class="conversation-status__row">
            <span>{{ t('desktop.chat.status.cost') }}</span><span>{{ formatCost(status.tokens.totals.totalCost) }}</span>
          </div>
          <div v-for="entry in status.tokens.byModel" :key="`${entry.providerId}:${entry.modelId}`" class="conversation-status__row is-model">
            <span>
              {{ modelLabel(entry.providerId, entry.modelId) }}
              <span v-if="entry.modelId === currentModelId" class="conversation-status__badge is-active">{{ t('desktop.chat.status.current') }}</span>
            </span>
            <span>{{ formatTokens(entry.totalTokens) }} · {{ t('desktop.chat.status.modelRuns', { count: entry.runCount }) }}<template v-if="formatCost(entry.totalCost)"> · {{ formatCost(entry.totalCost) }}</template></span>
          </div>
        </DesktopConversationStatusSection>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.conversation-status {
  display: flex;
  width: min(25rem, calc(100vw - 32px));
  max-height: min(42rem, calc(100vh - 112px));
  flex-direction: column;
  overflow: hidden;
  font-family: var(--buddy-font-ui);
  font-size: 13px;
  line-height: 1.5;
}

.conversation-status__header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--buddy-border-subtle);
  padding: 6px 10px;
}

.conversation-status__title {
  margin: 0;
  color: var(--buddy-text-strong);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.conversation-status__body {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--buddy-border-strong) transparent;
  padding: 6px 8px 8px;
}

.conversation-status__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 2px;
  white-space: nowrap;

  > span {
    flex: none;
  }

  > span:first-child {
    color: var(--buddy-text-primary);
  }

  > span:last-child {
    color: var(--buddy-text-strong);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  &.is-model > span:first-child {
    color: var(--buddy-text-strong);
  }
}

.conversation-status__values {
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 8px;
}

.conversation-status__badge {
  display: inline-block;
  border-radius: 3px;
  padding: 0 4px;
  font-size: 12px;
  font-weight: 500;

  &.is-warning {
    background: var(--buddy-status-warning-surface);
    color: var(--buddy-status-warning-text);
  }

  &.is-active {
    background: var(--buddy-accent-surface);
    color: var(--buddy-accent-on-surface);
  }
}

.conversation-status__empty {
  display: block;
  margin: 0;
  color: var(--buddy-text-secondary);
  padding: 4px 2px;
}
</style>
