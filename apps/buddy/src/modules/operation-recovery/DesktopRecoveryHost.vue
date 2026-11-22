<script setup lang="ts">
import type { OperationRecoveryProps } from './useOperationRecovery'
import { buddyUserContentToText } from '@buddy-shared/conversation/buddyUserContent'
import { NButton, NDrawer, NDrawerContent, NSpin, useMessage } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { DesktopDraftConflictDialog } from '@/modules/tasks/ui'
import { useOperationRecovery } from './useOperationRecovery'

const props = defineProps<OperationRecoveryProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { item, busy, loading, loadError, target, match, notification, reviewing, close, openSource, refresh, resolve, resolveConflict } = useOperationRecovery(props, error => message.error(error))
</script>

<template>
  <DesktopDraftConflictDialog
    v-if="reviewing && match" :conflict="match" :language="language"
    :resolve-conflict="resolveConflict" @close="reviewing = false"
  />
  <NDrawer :show="!!notification && !reviewing" placement="right" :width="420" @update:show="!$event && close()">
    <NDrawerContent :title="t('desktop.recovery.title')" closable>
      <NSpin v-if="loading" size="small" />
      <p v-else-if="loadError" role="alert">
        {{ loadError }}
      </p>
      <section v-else-if="item" class="grid gap-3">
        <strong>{{ t(item.method === 'composerDrafts.save' && item.canRestore ? 'desktop.recovery.unsavedInput' : `desktop.recovery.${item.state}`) }}</strong>
        <span v-if="item.sourceTitle || item.sourceKind === 'draft'" class="text-sm text-muted">{{ item.sourceTitle || t('desktop.tasks.newTask') }}</span>
        <time class="text-xs text-muted" :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString(language) }}</time>
        <pre v-if="item.content" class="m-0 max-h-60 overflow-auto whitespace-pre-wrap font-inherit text-sm [overflow-wrap:anywhere]">{{ buddyUserContentToText(item.content) }}</pre>
        <div class="flex flex-wrap gap-2">
          <NButton v-if="target" size="small" :disabled="busy" @click="openSource">
            {{ t('desktop.recovery.openTask') }}
          </NButton>
          <NButton v-if="item.canRestore" size="small" :disabled="busy" @click="resolve('restore')">
            {{ t('desktop.recovery.restore') }}
          </NButton>
          <NButton v-if="['accepted', 'rejected', 'not_accepted'].includes(item.state)" size="small" :disabled="busy" @click="resolve('acknowledge')">
            {{ t('desktop.recovery.acknowledge') }}
          </NButton>
        </div>
      </section>
      <template #footer>
        <NButton :disabled="busy || loading" @click="refresh">
          {{ t('desktop.recovery.refresh') }}
        </NButton>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>
