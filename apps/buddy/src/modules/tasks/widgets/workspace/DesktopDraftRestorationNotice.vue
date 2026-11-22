<script setup lang="ts">
import type { DraftRestorationChoice, DraftRestorationConflict, DraftRestorationState } from '../../state/drafts/typing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton } from 'naive-ui'
import { shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopDraftConflictDialog from './DesktopDraftConflictDialog.vue'

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

async function choose(key: string, choice: DraftRestorationChoice) {
  const resolved = await props.resolveConflict(key, choice)
  if (resolved) {
    showConflict.value = false
    emit('resolved')
  }
  return resolved
}

watch(() => props.conflict?.targetKey, () => {
  showConflict.value = false
})
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

  <DesktopDraftConflictDialog
    v-if="showConflict && conflict" :conflict="conflict" :language="language" :resolve-conflict="choose"
    @close="showConflict = false"
  />
</template>
