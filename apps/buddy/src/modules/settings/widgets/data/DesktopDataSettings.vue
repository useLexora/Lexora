<script setup lang="ts">
import type { DataSettingsProps } from './typing'
import { NAlert, NButton, NTag } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { createDesktopAgentUsage } from '@/modules/settings/model/desktopAgentUsage'
import DesktopRunLogSection from '@/modules/settings/widgets/data/DesktopRunLogSection.vue'

import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

const props = defineProps<DataSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const usage = computed(() => createDesktopAgentUsage(props.usageSnapshot))

function formatNumber(value: number) {
  return new Intl.NumberFormat(props.language, {
    maximumFractionDigits: 1,
    notation: value >= 10_000 ? 'compact' : 'standard',
  }).format(value)
}
</script>

<template>
  <div class="desktop-data-settings grid gap-[1.8rem] [container-type:inline-size]">
    <NAlert v-if="runtimeRestartError || usageError" type="error" :show-icon="false">
      {{ runtimeRestartError ?? usageError }}
    </NAlert>

    <section class="grid gap-[0.8rem]">
      <div class="grid gap-1">
        <h2 class="m-0 text-[0.92rem]">
          {{ t('desktop.settings.runtime') }}
        </h2>
        <p class="m-0 text-muted text-[0.72rem]">
          {{ t('desktop.settings.runtimeDescription') }}
        </p>
      </div>
      <DesktopSettingsGroup>
        <DesktopSettingRow :label="t('desktop.agent.statusTitle')" :description="t('desktop.agent.statusDescription')" toggle>
          <NTag
            :bordered="false"
            :type="runtimeState.status === 'ready' ? 'success'
              : 'warning'"
          >
            {{ t(`runtime.status.${runtimeState.status}`) }}
          </NTag>
        </DesktopSettingRow>
        <DesktopSettingRow :label="t('desktop.agent.currentModel')" toggle>
          <span class="text-muted text-[0.68rem]">{{ selectedModel?.displayName ?? t('desktop.agent.noModel') }}</span>
        </DesktopSettingRow>
      </DesktopSettingsGroup>
      <NAlert v-if="runtimeState.status === 'offline'" type="error" :show-icon="false">
        <p>{{ runtimeError ?? t('desktop.agent.runtimeUnknownFailure') }}</p>
        <p v-if="runtimeState.pid !== null">
          {{ t('desktop.agent.runtimeProcessStillRunning', { pid: runtimeState.pid }) }}
        </p>
        <NButton
          v-else
          secondary
          :disabled="!canRestartRuntime"
          @click="restartRuntime"
        >
          {{ t('desktop.agent.runtimeRestart') }}
        </NButton>
      </NAlert>
    </section>

    <section class="grid gap-[0.8rem]">
      <div class="grid gap-1">
        <h2 class="m-0 text-[0.92rem]">
          {{ t('desktop.agent.usageTitle') }}
        </h2>
        <p class="m-0 text-muted text-[0.72rem]">
          {{ t('desktop.agent.usageDescription') }}
        </p>
      </div>
      <DesktopSettingsGroup class="grid grid-cols-2">
        <div class="grid gap-1 border-r border-r-solid border-r-border p-[0.9rem]">
          <span class="text-muted text-[0.68rem]">{{ t('usage.totalTokens') }}</span><strong class="text-[1.1rem]">{{ formatNumber(usage.totals.totalTokens) }}</strong>
        </div>
        <div class="grid gap-1 p-[0.9rem]">
          <span class="text-muted text-[0.68rem]">{{ t('desktop.agent.recentRuns') }}</span><strong class="text-[1.1rem]">{{ usage.totals.recordCount }}</strong>
        </div>
      </DesktopSettingsGroup>
    </section>

    <section class="grid gap-[0.8rem]">
      <div class="grid gap-1">
        <h2 class="m-0 text-[0.92rem]">
          {{ t('desktop.settings.runLogs') }}
        </h2>
        <p class="m-0 text-muted text-[0.72rem]">
          {{ t('desktop.settings.runLogsDescription') }}
        </p>
      </div>
      <DesktopRunLogSection :language="language" :list-recent-runs="listRecentRuns" :list-run-events="listRunEvents" />
    </section>
  </div>
</template>
