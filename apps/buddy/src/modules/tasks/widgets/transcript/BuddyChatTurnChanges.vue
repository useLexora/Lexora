<script setup lang="ts">
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Code20Regular, Open16Regular } from '@vicons/fluent'
import { computed } from 'vue'

import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  changeSet: LocalChangeSetSummary
  language: BuddyLocale
}>()
const emit = defineEmits<{
  openChanges: [changeSetId: string]
}>()

const { t } = useBuddyI18n(() => props.language)
const summary = computed(() => t('desktop.chat.turnChanges', {
  count: props.changeSet.fileCount,
}))
</script>

<template>
  <button
    class="buddy-chat-turn-changes flex w-fit max-w-full items-center gap-[0.45rem] border-0 rounded-micro bg-transparent text-muted cursor-pointer py-1 px-[0.125rem] text-left hover:bg-accent-subtle hover:text-accent-text focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]"
    data-testid="chat-turn-changes"
    type="button"
    @click="emit('openChanges', changeSet.changeSetId)"
  >
    <DesktopIcon :component="Code20Regular" />
    <span>{{ summary }}</span>
    <DesktopIcon class="buddy-chat-turn-changes__open" :component="Open16Regular" />
  </button>
</template>

<style scoped lang="scss">
.buddy-chat-turn-changes > :deep(.n-icon) {
  width: 1rem;
  height: 1rem;
  flex: none;
  font-size: 1rem;
}

.buddy-chat-turn-changes span {
  overflow: hidden;
  font-size: var(--buddy-chat-caption-font-size);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.buddy-chat-turn-changes__open {
  color: var(--buddy-text-muted);
}
</style>
