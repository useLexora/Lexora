<script setup lang="ts">
import type { ConversationArchivePolicy } from '@buddy-shared/conversation/conversationArchiveApi'
import type { TaskArchiveActions } from '../../contracts'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton, NModal, NSelect } from 'naive-ui'
import { computed, onScopeDispose, shallowRef, useId, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'

const props = defineProps<{ actions: TaskArchiveActions, language: BuddyLocale, disabled: boolean }>()
const { t } = useBuddyI18n(() => props.language)
const labelId = useId()
const errorId = `${labelId}-error`
const days = shallowRef<ConversationArchivePolicy['days'] | null>(null)
const pending = shallowRef<ConversationArchivePolicy['days'] | null>(null)
const busy = shallowRef(false)
const error = shallowRef<string | null>(null)
let generation = 0
const choices = computed(() => [0, 3, 7, 30].map(value => ({ value, label: value === 0 ? t('desktop.archive.never') : t('desktop.archive.days', { days: value }) })))
async function load() {
  const token = ++generation
  days.value = null
  pending.value = null
  busy.value = false
  if (!props.actions.ready.value)
    return
  busy.value = true
  error.value = null
  try {
    const policy = await props.actions.getPolicy()
    if (token === generation)
      days.value = policy.days
  }
  catch (cause) {
    if (token === generation)
      error.value = resolveLocalChatErrorMessage(cause, props.language)
  }
  finally {
    if (token === generation)
      busy.value = false
  }
}
watch([() => props.actions, () => props.actions.ready.value], load, { immediate: true, flush: 'sync' })
onScopeDispose(() => generation++)
async function save(value: ConversationArchivePolicy['days']) {
  if (busy.value || !props.actions.ready.value || props.disabled)
    return
  const token = generation
  busy.value = true
  error.value = null
  try {
    const policy = await props.actions.setPolicy(value)
    if (token === generation) {
      days.value = policy.days
      pending.value = null
    }
  }
  catch (cause) {
    if (token === generation)
      error.value = resolveLocalChatErrorMessage(cause, props.language)
  }
  finally {
    if (token === generation)
      busy.value = false
  }
}
function select(value: ConversationArchivePolicy['days']) {
  if (days.value === null || days.value === value)
    return
  if (value !== 0 && (days.value === 0 || value < days.value))
    pending.value = value
  else
    void save(value)
}
</script>

<template>
  <div class="min-w-0">
    <span :id="labelId" class="sr-only">{{ t('desktop.archive.policy') }}</span>
    <NSelect id="archive-cleanup-policy" :aria-labelledby="labelId" :aria-describedby="error && pending === null ? errorId : undefined" :aria-disabled="disabled || busy || days === null || !actions.ready.value" :value="days" :options="choices" :render-tag="({ option }) => t('desktop.archive.policyValue', { value: String(option.label) })" :placeholder="t('desktop.archive.policy')" :disabled="disabled || busy || days === null || !actions.ready.value" :loading="busy" @update:value="select" />
    <div v-if="error && pending === null" class="mt-2 flex flex-col items-start gap-1">
      <span :id="errorId" role="alert" class="text-xs text-danger">{{ error }}</span>
      <NButton text size="small" :disabled="disabled || !actions.ready.value || busy" @click="load">
        {{ t('desktop.marks.retry') }}
      </NButton>
    </div>
    <NModal :show="pending !== null" data-testid="task-archive-policy-confirm" preset="dialog" type="warning" :title="t('desktop.archive.policy')" :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy" @update:show="!$event && !busy && (pending = null)">
      <p>{{ t('desktop.archive.policyConfirm', { days: pending ?? 0 }) }}</p>
      <NAlert v-if="error" type="error" :show-icon="false" role="alert">
        {{ error }}
      </NAlert>
      <template #action>
        <NButton :disabled="busy" @click="pending = null">
          {{ t('common.cancel') }}
        </NButton>
        <NButton type="error" :loading="busy" :disabled="!actions.ready.value || disabled" @click="pending !== null && save(pending)">
          {{ t('common.save') }}
        </NButton>
      </template>
    </NModal>
  </div>
</template>
