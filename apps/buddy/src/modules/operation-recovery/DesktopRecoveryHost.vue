<script setup lang="ts">
import type { ProductRecoveryItem } from '@buddy-shared/runtime/productRecovery'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { RegisterNotificationAction } from '@/modules/notifications'
import type { DesktopNotification } from '@/modules/notifications/contracts'
import { buddyUserContentToText } from '@buddy-shared/conversation/buddyUserContent'
import { NButton, NDrawer, NDrawerContent, NSpin, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

const props = defineProps<{ language: BuddyLocale, registerAction: RegisterNotificationAction, notifications: readonly DesktopNotification[] }>()
const emit = defineEmits<{ openTask: [id: string], openDraft: [id: string] }>()
const selectedId = shallowRef<string | null>(null)
onScopeDispose(props.registerAction('review-operation', (action) => {
  selectedId.value = action.recoveryId
}))
const notification = computed(() => props.notifications.find(entry => entry.kind === 'operation.recovery' && entry.action.recoveryId === selectedId.value))
watch(notification, (current) => {
  if (!current)
    selectedId.value = null
})
const runtime = requireDesktopApi().localChat.runtime
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const item = shallowRef<ProductRecoveryItem>()
const busy = shallowRef(false)
const loading = shallowRef(false)
const loadError = shallowRef('')
const refreshVersion = shallowRef(0)

watch([selectedId, () => notification.value?.revision, refreshVersion], async ([id], _, onCleanup) => {
  let current = true
  onCleanup(() => {
    current = false
  })
  item.value = undefined
  loadError.value = ''
  loading.value = Boolean(id)
  if (!id)
    return
  try {
    const [result] = await runtime.listRecovery(id)
    if (current) {
      item.value = result
      if (!result)
        selectedId.value = null
    }
  }
  catch (error) {
    if (current)
      loadError.value = resolveLocalChatErrorMessage(error, props.language)
  }
  finally {
    if (current)
      loading.value = false
  }
}, { immediate: true })

async function resolve(action: 'restore' | 'acknowledge') {
  const id = item.value?.id
  if (!id || busy.value)
    return
  busy.value = true
  try {
    if (action === 'restore')
      emit('openDraft', await runtime.restoreRecovery(id))
    else
      await runtime.acknowledgeRecovery(id)
    if (selectedId.value === id)
      selectedId.value = null
  }
  catch (error) {
    message.error(resolveLocalChatErrorMessage(error, props.language))
  }
  finally {
    busy.value = false
  }
}
function refresh() {
  refreshVersion.value++
}
</script>

<template>
  <NDrawer :show="!!notification" placement="right" :width="420" @update:show="!$event && (selectedId = null)">
    <NDrawerContent :title="t('desktop.recovery.title')" closable>
      <NSpin v-if="loading" size="small" />
      <p v-else-if="loadError" role="alert">
        {{ loadError }}
      </p>
      <section v-else-if="item" class="grid gap-3">
        <strong>{{ t(`desktop.recovery.${item.state}`) }}</strong>
        <time class="text-xs text-muted" :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString(language) }}</time>
        <pre v-if="item.content" class="m-0 max-h-60 overflow-auto whitespace-pre-wrap font-inherit text-sm [overflow-wrap:anywhere]">{{ buddyUserContentToText(item.content) }}</pre>
        <div class="flex flex-wrap gap-2">
          <NButton v-if="item.conversationId" size="small" @click="selectedId = null; emit('openTask', item.conversationId)">
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
