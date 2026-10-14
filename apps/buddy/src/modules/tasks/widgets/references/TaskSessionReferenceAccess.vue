<script setup lang="ts">
import type { TaskChatWorkspace } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Link20Regular } from '@vicons/fluent'
import { NButton, NPopover } from 'naive-ui'
import { computed, inject, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useSessionReferenceAccess } from '../../state/conversations/useSessionReferenceAccess'
import { sessionReferenceNavigationKey } from './sessionReferenceNavigation'

const props = defineProps<{
  api: TaskChatWorkspace['context']['references']
  conversationId: string | null
  branchId: string | null
  language: BuddyLocale
  active: boolean
}>()
const { t } = useBuddyI18n(() => props.language)
const open = shallowRef(false)
const navigate = inject(sessionReferenceNavigationKey, null)
const scope = computed(() => props.conversationId && props.branchId ? { conversationId: props.conversationId, branchId: props.branchId } : null)
const enabled = computed(() => props.active && open.value)
const { data, loading, pending, failed, refresh, setExcluded } = useSessionReferenceAccess({ api: props.api, scope, enabled })
watch(scope, () => open.value = false)
watch(() => props.active, (active) => {
  if (!active)
    open.value = false
})
</script>

<template>
  <NPopover v-if="scope" v-model:show="open" trigger="click" placement="top-start" :show-arrow="false" to=".buddy-app" :theme-overrides="{ padding: '0' }">
    <template #trigger>
      <button class="inline-flex items-center gap-1.5 border-0 rounded-micro bg-transparent text-muted text-xs px-2 py-1 cursor-pointer hover:bg-hover hover:text-fg ui-focus-ring" type="button" data-testid="task-reference-access">
        <DesktopIcon :component="Link20Regular" :size="14" />
        <span>{{ t('desktop.chat.referenceAccess.title') }}</span>
      </button>
    </template>
    <section class="task-reference-access grid w-[360px] max-w-[calc(100vw_-_40px)] text-fg" :aria-label="t('desktop.chat.referenceAccess.title')">
      <header class="grid gap-1 border-b-1 border-b-solid border-b-border p-3">
        <strong class="text-sm font-600">{{ t('desktop.chat.referenceAccess.title') }}</strong>
        <p class="m-0 text-xs leading-5 text-muted">
          {{ t('desktop.chat.referenceAccess.scope') }}
        </p>
      </header>
      <div v-if="failed" class="flex items-center justify-between gap-2 p-3" role="alert">
        <span class="text-xs">{{ t('desktop.chat.referenceAccess.failed') }}</span>
        <NButton size="tiny" :loading="loading" @click="refresh">
          {{ t('desktop.chat.referenceAccess.retry') }}
        </NButton>
      </div>
      <p v-else-if="!data" class="m-0 p-3 text-xs text-muted" role="status">
        {{ t('desktop.chat.referenceAccess.loading') }}
      </p>
      <p v-else-if="!data.references.length" class="m-0 p-3 text-xs text-muted">
        {{ t('desktop.chat.referenceAccess.empty') }}
      </p>
      <ul v-if="data?.references.length" class="grid gap-0 m-0 p-0 max-h-[320px] overflow-y-auto list-none">
        <li v-for="reference in data.references" :key="reference.id" class="flex min-w-0 items-center gap-3 px-3 py-2 border-b-1 border-b-solid border-b-border" :data-reference-id="reference.id" :data-reference-status="reference.status">
          <div class="grid min-w-0 flex-1 gap-1">
            <button class="truncate w-full border-0 bg-transparent p-0 text-left text-sm text-fg cursor-pointer hover:text-accent-text ui-focus-ring disabled:cursor-default" type="button" :disabled="!navigate" @click="navigate?.(reference.id)">
              {{ reference.title }}
            </button>
            <span v-if="reference.status !== 'available'" class="text-xs text-muted">{{ t(`desktop.chat.referenceAccess.${reference.status}`) }}</span>
            <span v-else-if="reference.depth === 0" class="text-xs text-muted">{{ t('desktop.chat.referenceAccess.direct') }}</span>
            <span v-else class="text-xs text-muted break-words">{{ t('desktop.chat.referenceAccess.via', { titles: reference.via.map(item => item.title).join('、') }) }}</span>
          </div>
          <NButton size="tiny" quaternary :disabled="pending !== null" :loading="pending === reference.id" @click="setExcluded(reference.id, reference.status !== 'revoked')">
            {{ t(reference.status === 'revoked' ? 'desktop.chat.referenceAccess.restore' : 'desktop.chat.referenceAccess.revoke') }}
          </NButton>
        </li>
      </ul>
      <footer class="grid gap-1 p-3 text-xs leading-5 text-muted">
        <p v-if="data?.truncated" class="m-0" role="status">
          {{ t('desktop.chat.referenceAccess.truncated', { depth: data.depthLimit, count: data.countLimit }) }}
        </p>
        <p class="m-0">
          {{ t('desktop.chat.referenceAccess.revokeHint') }}
        </p>
      </footer>
    </section>
  </NPopover>
</template>
