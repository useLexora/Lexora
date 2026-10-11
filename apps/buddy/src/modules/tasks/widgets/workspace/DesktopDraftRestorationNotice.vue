<script setup lang="ts">
import type { DraftRestorationConflict, DraftRestorationState } from '../../state/drafts/typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { buddyUserContentToText, getBuddyUserContentResourceIds } from '@buddy-shared/conversation/buddyUserContent'
import { NAlert, NButton, NModal } from 'naive-ui'
import { shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  conflict: DraftRestorationConflict | null
  language: BuddyLocale
  resolveRemote: (targetKey: string) => Promise<boolean>
  restore: () => Promise<void>
  state: DraftRestorationState
}>()
const { t } = useBuddyI18n(() => props.language)
const showConflict = shallowRef(false)
const resolving = shallowRef(false)
const resolutionFailed = shallowRef(false)

watch(() => props.conflict?.targetKey, () => {
  showConflict.value = false
  resolutionFailed.value = false
})

async function restoreSavedDraft(): Promise<void> {
  const conflict = props.conflict
  if (!conflict || resolving.value)
    return
  resolving.value = true
  resolutionFailed.value = false
  try {
    if (await props.resolveRemote(conflict.targetKey))
      showConflict.value = false
    else
      resolutionFailed.value = true
  }
  finally {
    resolving.value = false
  }
}
</script>

<template>
  <NAlert
    v-if="state !== 'ready'"
    class="desktop-draft-restoration"
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
    :title="t('desktop.chat.draftRestoration.title')"
    :mask-closable="!resolving"
    :closable="!resolving"
    :close-on-esc="!resolving"
  >
    <div v-if="conflict" class="desktop-draft-restoration__comparison grid gap-[12px]">
      <p>{{ t('desktop.chat.draftRestoration.explanation') }}</p>
      <section v-for="(draft, index) in [conflict.local, conflict.remote]" :key="draft.draftId">
        <strong>{{ t(index === 0 ? 'desktop.chat.draftRestoration.local' : 'desktop.chat.draftRestoration.saved') }}</strong>
        <pre>{{ buddyUserContentToText(draft.content).trim() || t('desktop.chat.draftRestoration.empty') }}</pre>
        <small v-if="getBuddyUserContentResourceIds(draft.content).length">
          {{ t('desktop.chat.draftRestoration.resources', { count: getBuddyUserContentResourceIds(draft.content).length }) }}
        </small>
      </section>
      <NAlert v-if="resolutionFailed" type="warning" :bordered="false">
        {{ t('desktop.chat.draftRestoration.resolveFailed') }}
      </NAlert>
    </div>
    <template #action>
      <NButton :disabled="resolving" @click="showConflict = false">
        {{ t('desktop.chat.draftRestoration.keepLocal') }}
      </NButton>
      <NButton type="warning" :loading="resolving" @click="restoreSavedDraft">
        {{ t('desktop.chat.draftRestoration.useSaved') }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-draft-restoration {
  width: 100%;
}

.desktop-draft-restoration__comparison {
  p {
    margin: 0;
  }

  section {
    min-width: 0;
    border: 1px solid var(--buddy-border-subtle);
    border-radius: 8px;
    padding: 10px;
  }

  pre {
    max-height: 160px;
    overflow: auto;
    margin: 6px 0;
    font: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}
</style>
