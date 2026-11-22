<script setup lang="ts">
import type { DraftRestorationChoice, DraftRestorationConflict } from '../../state/drafts/typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { buddyUserContentToText, getBuddyUserContentResourceIds } from '@buddy-shared/conversation/buddyUserContent'
import { ChevronRight16Regular } from '@vicons/fluent'
import { NAlert, NButton, NModal } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  conflict: DraftRestorationConflict
  language: BuddyLocale
  resolveConflict: (targetKey: string, choice: DraftRestorationChoice) => Promise<boolean>
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useBuddyI18n(() => props.language)
const resolving = shallowRef(false)
const resolutionFailed = shallowRef(false)
const choices = computed(() => {
  const conflict = props.conflict
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

async function choose(choice: DraftRestorationChoice): Promise<void> {
  if (resolving.value)
    return
  resolving.value = true
  resolutionFailed.value = false
  try {
    resolutionFailed.value = !await props.resolveConflict(props.conflict.targetKey, choice)
  }
  finally {
    resolving.value = false
  }
}
</script>

<template>
  <NModal
    :show="true"
    preset="dialog"
    type="warning"
    class="!w-[min(31rem,calc(100vw_-_2rem))]"
    :title="t('desktop.chat.draftRestoration.title')"
    :mask-closable="!resolving"
    :closable="!resolving"
    :close-on-esc="!resolving"
    @update:show="!$event && emit('close')"
  >
    <p class="mt-0 mb-4 text-sm text-muted">
      {{ t('desktop.chat.draftRestoration.description') }}
    </p>
    <div class="desktop-draft-restoration__comparison grid gap-2" :aria-busy="resolving">
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
