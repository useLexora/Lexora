<script setup lang="ts">
import type {
  DocsChatHistoryDropdownEmits,
  DocsChatHistoryDropdownProps,
} from './typing'
import { ArrowDown } from '@element-plus/icons-vue'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  buildDocsChatHistoryGroups,
  limitDocsChatHistorySessions,
} from '../../utils/docsChatHistory'

const props = defineProps<DocsChatHistoryDropdownProps>()
const emits = defineEmits<DocsChatHistoryDropdownEmits>()
const { t } = useI18n()

const historySessions = computed(() => limitDocsChatHistorySessions(props.sessions))
const historyGroups = computed(() => buildDocsChatHistoryGroups(historySessions.value))
const visible = shallowRef(false)

function selectSession(sessionId: string) {
  emits('select', sessionId)
  visible.value = false
}
</script>

<template>
  <ElPopover
    v-model:visible="visible"
    placement="bottom-start"
    trigger="click"
    :width="304"
    popper-class="docs-chat-history-dropdown__popover"
    :popper-style="{ padding: '0' }"
    @show="emits('load')"
  >
    <template #reference>
      <button
        type="button"
        class="docs-chat-history-dropdown__trigger inline-flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-sm font-semibold leading-5 text-main"
      >
        <span class="docs-chat-history-dropdown__trigger-title min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ props.title }}</span>
        <ElIcon class="flex-none text-xs text-secondary">
          <ArrowDown />
        </ElIcon>
      </button>
    </template>

    <div class="docs-chat-history-dropdown max-h-[min(60vh,26rem)] min-h-16 overflow-y-auto p-1.5">
      <ElSkeleton v-if="props.isLoading" animated class="px-2 py-2">
        <template #template>
          <div class="grid gap-2">
            <ElSkeletonItem variant="text" class="max-w-20" />
            <ElSkeletonItem v-for="item in 4" :key="item" variant="rect" class="h-8 w-full" />
          </div>
        </template>
      </ElSkeleton>

      <div v-else-if="historySessions.length === 0" class="px-3 py-5 text-center text-[13px] text-secondary">
        {{ t('docs.chat.historyEmpty') }}
      </div>

      <template v-else>
        <section
          v-for="(group, index) in historyGroups"
          :key="group.id"
          class="docs-chat-history-dropdown__group"
          :class="index > 0 ? 'mt-2 border-t border-[color-mix(in_srgb,var(--brand-border-base)_64%,transparent)] pt-2' : ''"
        >
          <div class="px-2 py-1 text-xs leading-[1.125rem] text-secondary">
            {{ group.label }}
          </div>

          <button
            v-for="session in group.sessions"
            :key="session.id"
            type="button"
            class="docs-chat-history-dropdown__item flex h-8 w-full min-w-0 items-center rounded-lg border-0 bg-transparent px-2 text-left text-main"
            :class="{ 'is-active': session.id === props.activeSessionId }"
            @click="selectSession(session.id)"
          >
            <span class="min-w-0 overflow-hidden text-[13px] leading-5 text-ellipsis whitespace-nowrap">
              {{ session.title }}
            </span>
          </button>
        </section>
      </template>
    </div>
  </ElPopover>
</template>

<style scoped lang="scss">
.docs-chat-history-dropdown__trigger {
  cursor: pointer;

  &:hover,
  &:focus-visible {
    background: color-mix(in srgb, var(--brand-fill-lighter) 72%, transparent);
    outline: none;
  }
}

.docs-chat-history-dropdown__item {
  cursor: pointer;

  &:hover,
  &:focus-visible,
  &.is-active {
    background: color-mix(in srgb, var(--brand-primary) 8%, white);
    color: var(--brand-primary);
    outline: none;
  }
}
</style>
