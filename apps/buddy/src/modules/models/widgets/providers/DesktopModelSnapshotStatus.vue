<script setup lang="ts">
import type { LocalModelSnapshot } from '@buddy-shared/providers/providerApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowSync20Regular, FolderOpen20Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  refreshing: boolean
  snapshot: LocalModelSnapshot | null
}>()
const emit = defineEmits<{
  openDirectory: []
  refresh: []
}>()
const { t } = useBuddyI18n(() => props.language)
const updatedAt = computed(() => formatDate(props.snapshot?.updatedAt))
const checkedAt = computed(() => formatDate(
  props.snapshot?.lastAttemptAt ?? props.snapshot?.checkedAt,
))

function formatDate(value: string | null | undefined) {
  if (!value)
    return t('desktop.providers.snapshotUnknownTime')
  return new Intl.DateTimeFormat(props.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
</script>

<template>
  <div class="desktop-model-snapshot-status flex min-h-[4.2rem] items-center gap-4 border border-solid border-border rounded-[0.65rem] bg-surface py-3 px-[0.9rem]">
    <div class="desktop-model-snapshot-status__copy grid min-w-0 flex-1 gap-[0.24rem]">
      <span v-if="snapshot">
        <a class="desktop-model-snapshot-status__source text-inherit underline hover:text-accent-text focus-visible:rounded-micro focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]" href="https://models.dev" target="_blank" rel="noopener noreferrer">Models.dev</a>
        ·
        {{ t('desktop.providers.snapshotSummary', {
          models: snapshot.modelCount,
          providers: snapshot.providerCount,
        }) }}
      </span>
      <span v-else>{{ t('desktop.providers.snapshotUnavailable') }}</span>
      <span v-if="snapshot">
        {{ t('desktop.providers.snapshotUpdatedAt', { updatedAt }) }}
      </span>
      <span v-if="snapshot?.checkedAt || snapshot?.lastAttemptAt">
        {{ t('desktop.providers.snapshotCheckedAt', { checkedAt }) }}
      </span>
      <span v-if="snapshot?.errorCount" class="desktop-model-snapshot-status__warning">
        {{ t('desktop.providers.snapshotRefreshPartial', { count: snapshot.errorCount }) }}
      </span>
    </div>
    <div class="flex flex-none items-center gap-2">
      <NButton size="small" @click="emit('openDirectory')">
        <template #icon>
          <DesktopIcon :component="FolderOpen20Regular" />
        </template>
        {{ t('desktop.providers.openModelSnapshotDirectory') }}
      </NButton>
      <NButton size="small" :loading="refreshing" @click="emit('refresh')">
        <template #icon>
          <DesktopIcon :component="ArrowSync20Regular" />
        </template>
        {{ t('desktop.providers.refreshModelSnapshot') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-model-snapshot-status__copy > span {
  color: var(--buddy-text-secondary);
  font-size: 0.68rem;
  line-height: 1.45;
}

.desktop-model-snapshot-status__copy > .desktop-model-snapshot-status__warning {
  color: var(--buddy-status-warning-text);
}

.desktop-model-snapshot-status__source {
  text-underline-offset: 0.16em;
}
</style>
