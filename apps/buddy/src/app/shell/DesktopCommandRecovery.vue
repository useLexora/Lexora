<script setup lang="ts">
import type { ProductRecoveryItem } from '@buddy-shared/runtime/productRecovery'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { buddyUserContentToText } from '@buddy-shared/conversation/buddyUserContent'
import { useIntervalFn } from '@vueuse/core'
import { NButton, NDrawer, NDrawerContent, useMessage } from 'naive-ui'
import { onMounted, onScopeDispose, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

const props = defineProps<{ language: BuddyLocale }>()
const emit = defineEmits<{ openTask: [id: string], openDraft: [id: string] }>()
const api = requireDesktopApi().localChat.runtime
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const items = shallowRef<ProductRecoveryItem[]>([])
const visible = shallowRef(false)
const busy = shallowRef(false)
let disposed = false
let refreshVersion = 0
async function refresh() {
  if (busy.value)
    return
  const version = ++refreshVersion
  try {
    const result = await api.listRecovery()
    if (!disposed && version === refreshVersion)
      items.value = result
  }
  catch {}
}
async function act(item: ProductRecoveryItem, action: 'restore' | 'acknowledge') {
  busy.value = true
  refreshVersion += 1
  try {
    if (action === 'restore') {
      const draftId = await api.restoreRecovery(item.id)
      visible.value = false
      emit('openDraft', draftId)
    }
    else {
      await api.acknowledgeRecovery(item.id)
    }
  }
  catch (error) {
    message.error(resolveLocalChatErrorMessage(error, props.language))
  }
  finally {
    busy.value = false
    await refresh()
  }
}
useIntervalFn(refresh, 15_000)
onMounted(refresh)
onScopeDispose(api.onStateChanged(state => state.status === 'ready' && void refresh()))
onScopeDispose(() => {
  disposed = true
})
</script>

<template>
  <div v-if="items.length" class="flex items-center justify-between gap-3 border-b border-border bg-subtle px-4 py-2 text-sm" role="status">
    <span>{{ t('desktop.recovery.pending', { count: items.length }) }}</span>
    <NButton size="small" secondary @click="visible = true">
      {{ t('desktop.recovery.review') }}
    </NButton>
  </div>
  <NDrawer v-model:show="visible" placement="right" :width="420">
    <NDrawerContent :title="t('desktop.recovery.title')" closable>
      <p class="mt-0 text-muted">
        {{ t('desktop.recovery.description') }}
      </p>
      <div class="grid gap-4">
        <section v-for="item in items" :key="item.id" class="grid gap-3 rounded-2 border border-solid border-border p-3">
          <strong>{{ t(`desktop.recovery.${item.state}`) }}</strong>
          <time class="text-xs text-muted" :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString(language) }}</time>
          <pre v-if="item.content" class="m-0 max-h-60 overflow-auto whitespace-pre-wrap font-inherit text-sm [overflow-wrap:anywhere]">{{ buddyUserContentToText(item.content) }}</pre>
          <div class="flex flex-wrap gap-2">
            <NButton v-if="item.conversationId" size="small" @click="emit('openTask', item.conversationId)">
              {{ t('desktop.recovery.openTask') }}
            </NButton>
            <NButton v-if="item.canRestore" size="small" :loading="busy" :disabled="busy" @click="act(item, 'restore')">
              {{ t('desktop.recovery.restore') }}
            </NButton>
            <NButton v-if="['accepted', 'rejected', 'not_accepted'].includes(item.state)" size="small" :disabled="busy" @click="act(item, 'acknowledge')">
              {{ t('desktop.recovery.acknowledge') }}
            </NButton>
          </div>
        </section>
      </div>
      <template #footer>
        <NButton :disabled="busy" @click="refresh">
          {{ t('desktop.recovery.refresh') }}
        </NButton>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>
