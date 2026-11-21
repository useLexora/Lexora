<script setup lang="ts">
import type { DraftRestorationChoice, DraftRestorationConflict, DraftRestorationState } from '../../state/drafts/typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { buddyUserContentToText, getBuddyUserContentResourceIds } from '@buddy-shared/conversation/buddyUserContent'
import { ChevronRight16Regular } from '@vicons/fluent'
import { NAlert, NButton, NModal } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  conflict: DraftRestorationConflict | null
  language: BuddyLocale
  resolveConflict: (targetKey: string, choice: DraftRestorationChoice) => Promise<boolean>
  restore: () => Promise<void>
  state: DraftRestorationState
}>()
const emit = defineEmits<{ resolved: [] }>()
const { t } = useBuddyI18n(() => props.language)
const showConflict = shallowRef(false)
const resolving = shallowRef(false)
const resolutionFailed = shallowRef(false)
const choices = computed(() => {
  const conflict = props.conflict
  if (!conflict)
    return []
  return (['local', 'saved'] as const).map((key) => {
    const { content } = key === 'local' ? conflict.local : conflict.remote
    return {
      key,
      text: buddyUserContentToText(content).trim(),
      files: getBuddyUserContentResourceIds(content).length,
      unavailable: key === 'local' && !conflict.canUseLocal,
    }
  })
})

watch(() => props.conflict?.targetKey, () => {
  showConflict.value = false
  resolutionFailed.value = false
})

async function choose(choice: DraftRestorationChoice): Promise<void> {
  if (!props.conflict || resolving.value)
    return
  resolving.value = true
  resolutionFailed.value = false
  try {
    if (await props.resolveConflict(props.conflict.targetKey, choice)) {
      showConflict.value = false
      emit('resolved')
    }
    else {
      resolutionFailed.value = true
    }
  }
  finally {
    resolving.value = false
  }
}
</script>

<template>
  <NAlert
    v-if="state !== 'ready'"
    class="desktop-draft-restoration w-full"
    :type="state === 'failed' || state === 'conflict' ? 'warning' : 'info'"
    :bordered="false"
    role="status"
  >
    {{ t(`desktop.chat.draftRestoration.${state === 'pending' ? 'restoring' : state}`) }}
    <div v-if="state === 'failed' || state === 'conflict'" class="mt-[8px]">
      <NButton v-if="state === 'failed'" size="small" @click="restore">
        {{ t('desktop.chat.draftRestoration.retry') }}
      </NButton>
      <NButton v-else size="small" @click="showConflict = true">
        {{ t('desktop.chat.draftRestoration.review') }}
      </NButton>
    </div>
  </NAlert>

  <NModal
    v-model:show="showConflict"
    preset="dialog"
    type="warning"
    class="!w-[min(31rem,calc(100vw_-_2rem))]"
    :title="t('desktop.chat.draftRestoration.title')"
    :mask-closable="!resolving"
    :closable="!resolving"
    :close-on-esc="!resolving"
  >
    <p class="mt-0 mb-4 text-sm text-muted">
      {{ t('desktop.chat.draftRestoration.description') }}
    </p>
    <div v-if="conflict" class="desktop-draft-restoration__comparison grid gap-2" :aria-busy="resolving">
      <button
        v-for="option in choices" :key="option.key" type="button"
        class="ui-focus-ring grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border border-solid border-border rounded-control bg-surface px-4 py-3 text-left font-ui text-fg enabled:cursor-pointer enabled:hover:(border-accent-border bg-subtle) disabled:cursor-not-allowed"
        :disabled="resolving || option.unavailable" @click="choose(option.key)"
      >
        <span class="text-xs text-muted">{{ t(`desktop.chat.draftRestoration.${option.key}`) }}</span>
        <DesktopIcon v-if="!option.unavailable" class="row-span-2 text-muted" :component="ChevronRight16Regular" aria-hidden="true" />
        <span class="col-start-1 max-h-28 overflow-y-auto whitespace-pre-wrap text-[length:var(--buddy-chat-user-font-size)] leading-relaxed text-fg [overflow-wrap:anywhere]">{{ option.text || t('desktop.chat.draftRestoration.empty') }}</span>
        <small v-if="option.files" class="col-span-full text-muted">
          {{ t('desktop.chat.draftRestoration.resources', { count: option.files }) }}
          <template v-if="option.unavailable">{{ t('desktop.chat.draftRestoration.removeFiles') }}</template>
        </small>
      </button>
      <NAlert v-if="resolutionFailed" type="warning" :bordered="false">
        {{ t('desktop.chat.draftRestoration.resolveFailed') }}
      </NAlert>
    </div>
    <template #action>
      <NButton quaternary :disabled="resolving" @click="choose('empty')">
        {{ t('desktop.chat.draftRestoration.startOver') }}
      </NButton>
    </template>
  </NModal>
</template>
