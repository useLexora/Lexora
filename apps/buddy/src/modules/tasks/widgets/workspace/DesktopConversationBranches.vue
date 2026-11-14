<script setup lang="ts">
import type { LocalConversationBranch } from '@buddy-shared/conversation/conversationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NPopover } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  branches: readonly LocalConversationBranch[]
  branchId: string | null
  language: BuddyLocale
  disabled: boolean
  refresh: () => Promise<void>
}>()
const emit = defineEmits<{ select: [branchId: string, beside: boolean] }>()
const { t } = useBuddyI18n(() => props.language)
const shown = shallowRef(false)
const failed = shallowRef(false)
const loading = shallowRef(false)
const ordered = computed(() => [...props.branches].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)))
async function refresh(open: boolean) {
  if (!open)
    return
  loading.value = true
  failed.value = false
  try {
    await props.refresh()
  }
  catch {
    failed.value = true
  }
  finally {
    loading.value = false
  }
}
function select(branchId: string, beside = false) {
  shown.value = false
  emit('select', branchId, beside)
}
</script>

<template>
  <NPopover v-model:show="shown" trigger="click" placement="bottom-end" :show-arrow="false" @update:show="refresh">
    <template #trigger>
      <NButton quaternary size="small" data-testid="conversation-branches" :data-branch-id="branchId" :disabled="disabled" :aria-expanded="shown">
        {{ t('desktop.chat.conversationBranches') }}
      </NButton>
    </template>
    <div class="conversation-branches grid max-h-72 min-w-56 max-w-80 gap-1 overflow-y-auto">
      <span v-if="loading" class="px-2 py-1 text-muted">{{ t('desktop.chat.branchesLoading') }}</span>
      <span v-if="failed" class="px-2 py-1 text-muted">{{ t('desktop.chat.branchesUnavailable') }}</span>
      <div v-for="(branch, index) in ordered" :key="branch.id" class="flex items-center gap-2">
        <button
          type="button" class="conversation-branches__item grid flex-1 gap-1 rounded-control border-0 bg-transparent p-2 text-left text-fg cursor-pointer ui-focus-ring"
          :class="{ 'is-selected': branch.id === branchId }"
          :data-testid="`conversation-branch-${branch.id}`" :aria-pressed="branch.id === branchId"
          @click="select(branch.id)"
        >
          <span class="flex items-center justify-between gap-4">
            <span>{{ index === 0 ? t('desktop.chat.originalBranch') : t('desktop.chat.numberedBranch', { index: index + 1 }) }}</span>
            <span v-if="branch.id === branchId" class="text-xs text-muted">{{ t('desktop.chat.viewedBranch') }}</span>
          </span>
          <time class="text-xs text-muted" :datetime="branch.createdAt">{{ new Date(branch.createdAt).toLocaleString(language) }}</time>
        </button>
        <NButton v-if="branch.id !== branchId" quaternary size="tiny" :data-testid="`conversation-branch-beside-${branch.id}`" @click="select(branch.id, true)">
          {{ t('desktop.chat.openBranchBeside') }}
        </NButton>
      </div>
    </div>
  </NPopover>
</template>

<style scoped lang="scss">
.conversation-branches__item:hover,
.conversation-branches__item.is-selected {
  background: var(--buddy-state-hover);
}
</style>
