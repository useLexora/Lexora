<script setup lang="ts">
import type { ApplicationLogLaunch, ApplicationLogQuery } from '@buddy-shared/diagnostics/applicationLog'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { APPLICATION_LOG_CATEGORIES } from '@buddy-shared/diagnostics/applicationLog'
import { ArrowClockwise20Regular, ArrowDownload20Regular, Pause20Regular, Play20Regular, Search20Regular } from '@vicons/fluent'
import { NButton, NInput, NSelect } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { formatLogTime } from '../../model/applicationLogPresentation'

const props = defineProps<{ language: BuddyLocale, launches: ApplicationLogLaunch[], currentLaunchId?: string, live: boolean, loading: boolean, exporting: boolean }>()
const emit = defineEmits<{ refresh: [], toggleLive: [], exportDiagnostics: [] }>()
const launch = defineModel<string>('launch', { required: true })
const category = defineModel<NonNullable<ApplicationLogQuery['category']>>('category', { required: true })
const level = defineModel<NonNullable<ApplicationLogQuery['level']>>('level', { required: true })
const search = defineModel<string>('search', { required: true })
const { t } = useBuddyI18n(() => props.language)
const launchOptions = computed(() => [
  { value: 'current', label: t('applicationLogs.currentLaunch') },
  { value: 'all', label: t('applicationLogs.allLaunches') },
  ...props.launches.filter(item => item.launchId !== props.currentLaunchId).map(item => ({ value: item.launchId, label: `${formatLogTime(item.firstRecordedAt, props.language, true)} · v${item.appVersion}` })),
])
const categoryOptions = computed(() => [
  { value: 'all', label: t('applicationLogs.allCategories') },
  ...APPLICATION_LOG_CATEGORIES.map(value => ({ value, label: t(`applicationLogs.category.${value}`) })),
])
const levelOptions = computed(() => (['all', 'error', 'warn', 'info', 'debug'] as const).map(value => ({ value, label: t(`applicationLogs.level.${value}`) })))
</script>

<template>
  <div class="log-filters">
    <div class="log-filters__search">
      <NInput v-model:value="search" size="small" clearable :maxlength="256" :placeholder="t('applicationLogs.search')" :aria-label="t('applicationLogs.search')">
        <template #prefix>
          <DesktopIcon :component="Search20Regular" />
        </template>
      </NInput>
      <NButton size="small" secondary :aria-pressed="live" @click="emit('toggleLive')">
        <template #icon>
          <DesktopIcon :component="live ? Pause20Regular : Play20Regular" />
        </template>
        {{ t(live ? 'applicationLogs.pause' : 'applicationLogs.follow') }}
      </NButton>
      <NButton size="small" secondary :loading="exporting" :disabled="exporting" @click="emit('exportDiagnostics')">
        <template #icon>
          <DesktopIcon :component="ArrowDownload20Regular" />
        </template>
        {{ t('applicationLogs.exportDiagnostics') }}
      </NButton>
      <NButton size="small" quaternary :disabled="loading" :aria-label="t('applicationLogs.refresh')" :title="t('applicationLogs.refresh')" @click="emit('refresh')">
        <template #icon>
          <DesktopIcon :component="ArrowClockwise20Regular" />
        </template>
      </NButton>
    </div>
    <div class="log-filters__selectors">
      <NSelect v-model:value="launch" size="small" :options="launchOptions" :aria-label="t('applicationLogs.launch')" class="log-filters__launch" />
      <NSelect v-model:value="category" size="small" :options="categoryOptions" :aria-label="t('applicationLogs.category')" />
      <NSelect v-model:value="level" size="small" :options="levelOptions" :aria-label="t('applicationLogs.level')" />
    </div>
  </div>
</template>

<style scoped>
.log-filters { display: grid; flex: none; gap: 0.65rem; }
.log-filters__search { display: flex; align-items: center; gap: 0.5rem; }
.log-filters__search > :first-child { min-width: 0; flex: 1; }
.log-filters__selectors { display: grid; grid-template-columns: minmax(10rem, 1.4fr) minmax(8rem, 1fr) minmax(6rem, 0.65fr); gap: 0.5rem; }
@media (max-width: 1000px) {
  .log-filters__selectors { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .log-filters__launch { grid-column: 1 / -1; }
}
</style>
