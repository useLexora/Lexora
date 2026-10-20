<script setup lang="ts">
import type { LocalChangeRecoveryItem } from '@buddy-shared/changes/changeApi'
import type { TaskChangeRecovery } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton, NDropdown, NModal } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopChangeRecoveryItems from './DesktopChangeRecoveryItems.vue'

const props = defineProps<{
  recovery: TaskChangeRecovery
  language: BuddyLocale
}>()
const { t } = useBuddyI18n(() => props.language)
const items = computed(() => props.recovery.items.value)
const busy = computed(() => props.recovery.busy.value)
const error = computed(() => props.recovery.error.value)
const waived = computed(() => props.recovery.waived.value)
const confirmation = shallowRef<{ conversationId: string, items: readonly LocalChangeRecoveryItem[] } | null>(null)
const unknownItems = computed(() => items.value.filter(item => item.status === 'unknown'))
const moreOptions = computed(() => [{ key: 'waive', label: t('desktop.chat.changeRecovery.acceptRisk'), disabled: !unknownItems.value.length }])
const confirmationChanged = computed(() => confirmation.value?.items.some(selected =>
  !items.value.some(item => item.invocationId === selected.invocationId && item.revision === selected.revision && item.status === 'unknown'),
) ?? false)

watch(() => props.recovery.conversationId.value, () => {
  confirmation.value = null
})

function reviewRisk() {
  const conversationId = props.recovery.conversationId.value
  if (!conversationId || busy.value || !unknownItems.value.length)
    return
  confirmation.value = {
    conversationId,
    items: unknownItems.value.slice(0, 100).map(item => ({ ...item, affectedResources: [...item.affectedResources] })),
  }
}

async function acceptRisk() {
  const snapshot = confirmation.value
  if (!snapshot || busy.value || confirmationChanged.value)
    return
  const accepted = await props.recovery.resolve({
    conversationId: snapshot.conversationId,
    items: snapshot.items.map(item => ({ invocationId: item.invocationId, revision: item.revision })),
    decision: 'waived',
  })
  if (accepted && confirmation.value === snapshot)
    confirmation.value = null
}
</script>

<template>
  <NAlert
    v-if="items.length || error"
    class="desktop-change-recovery w-full"
    type="warning"
    :bordered="false"
    :title="t('desktop.chat.changeRecovery.title')"
    role="status"
  >
    <p v-if="items.length" class="mt-0 mb-2">
      {{ t('desktop.chat.changeRecovery.description') }}
    </p>
    <DesktopChangeRecoveryItems :items="items" :language="language" />
    <p v-if="error" class="mt-2 mb-0" role="alert">
      {{ t(`desktop.chat.changeRecovery.${error}`) }}
    </p>
    <div class="mt-2 flex flex-wrap gap-2">
      <NButton size="small" :loading="busy" @click="recovery.recheck">
        {{ t('desktop.chat.changeRecovery.recheck') }}
      </NButton>
      <NDropdown v-if="unknownItems.length" trigger="click" :options="moreOptions" @select="reviewRisk">
        <NButton size="small" quaternary :disabled="busy">
          {{ t('desktop.chat.changeRecovery.more') }}
        </NButton>
      </NDropdown>
    </div>
  </NAlert>
  <NAlert v-if="waived" type="info" :bordered="false" closable role="status" @close="recovery.dismissWaived">
    {{ t('desktop.chat.changeRecovery.waived') }}
  </NAlert>
  <NModal
    :show="confirmation !== null"
    preset="dialog"
    type="warning"
    :title="t('desktop.chat.changeRecovery.confirmTitle')"
    :mask-closable="!busy"
    :closable="!busy"
    :close-on-esc="!busy"
    @update:show="!$event && (confirmation = null)"
  >
    <template v-if="confirmation">
      <p>{{ t('desktop.chat.changeRecovery.confirmDescription', { count: confirmation.items.length }) }}</p>
      <DesktopChangeRecoveryItems :items="confirmation.items" :language="language" />
      <p>{{ t('desktop.chat.changeRecovery.noReplay') }}</p>
      <NAlert v-if="confirmationChanged || error === 'resolveFailed'" type="warning" :bordered="false">
        {{ t(confirmationChanged ? 'desktop.chat.changeRecovery.changed' : 'desktop.chat.changeRecovery.resolveFailed') }}
      </NAlert>
    </template>
    <template #action>
      <NButton :disabled="busy" @click="confirmation = null">
        {{ t('common.cancel') }}
      </NButton>
      <NButton type="warning" :loading="busy" :disabled="confirmationChanged" @click="acceptRisk">
        {{ t('desktop.chat.changeRecovery.acceptRisk') }}
      </NButton>
    </template>
  </NModal>
</template>
