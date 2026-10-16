<script setup lang="ts">
import type { ChatComposerModelRef, ChatComposerModelSelectionKind } from './typing'
import { AI_MODEL_INTENT_KEY } from '@haohaoxue/lexora-contracts/ai/constants'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ModelCascader from '@/components/model-cascader'

const props = withDefaults(defineProps<{
  selectedModelRef?: ChatComposerModelRef | null
  selectionKind?: ChatComposerModelSelectionKind
  disabled?: boolean
}>(), {
  selectionKind: 'default',
})

const emits = defineEmits<{
  select: [modelRef: ChatComposerModelRef | null]
}>()
const { t } = useI18n({ useScope: 'global' })

function handleSelect(modelRef: ChatComposerModelRef | null) {
  emits('select', modelRef)
}

const selectionTooltip = computed(() => {
  if (props.selectionKind === 'override') {
    return t('chat.composer.currentModel')
  }

  if (props.selectionKind === 'draft') {
    return t('chat.composer.newChatModel')
  }

  return t('chat.composer.defaultModel')
})
</script>

<template>
  <ElTooltip :content="selectionTooltip" placement="top" :show-after="300">
    <div
      class="chat-model-trigger"
      :class="[`is-${props.selectionKind}`, { 'is-disabled': props.disabled }]"
      :data-model-selection-kind="props.selectionKind"
    >
      <ModelCascader
        :model-value="props.selectedModelRef"
        :intent-key="AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT"
        :clearable="true"
        :filterable="true"
        :show-all-levels="false"
        popper-class="chat-model-trigger__popper"
        :disabled="props.disabled"
        :placeholder="t('chat.composer.selectModel')"
        @update:model-value="handleSelect"
      />
    </div>
  </ElTooltip>
</template>

<style scoped lang="scss">
.chat-model-trigger {
  display: inline-flex;
  position: relative;
  flex: 1 1 0;
  min-width: 0;

  &.is-override::after,
  &.is-draft::after {
    position: absolute;
    inset-block-start: 0.3125rem;
    inset-inline-end: 0.3125rem;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    content: '';
    pointer-events: none;
  }

  &.is-override::after {
    background: var(--brand-primary);
  }

  &.is-draft::after {
    background: var(--el-color-warning);
  }

  :deep(.el-cascader) {
    width: 100%;
    min-width: 0;
    line-height: normal;
  }

  :deep(.el-cascader .el-input) {
    width: 100%;
    min-width: 0;
  }

  :deep(.el-cascader .el-input__wrapper) {
    min-height: 2rem;
    height: 2rem;
    padding: 0 0.5rem;
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 74%, transparent);
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--brand-fill-light) 36%, transparent);
    box-shadow: none;
    transition:
      border-color 0.2s ease,
      background-color 0.2s ease;
  }

  &.is-override,
  &.is-draft {
    :deep(.el-cascader .el-input__wrapper) {
      padding-inline-end: 0.875rem;
    }
  }

  :deep(.el-cascader:not(.is-disabled) .el-input__wrapper:hover) {
    border-color: color-mix(in srgb, var(--brand-border-base) 74%, transparent);
    background: color-mix(in srgb, var(--brand-fill-light) 72%, transparent);
  }

  :deep(.el-cascader .el-input.is-focus .el-input__wrapper),
  :deep(.el-cascader .el-input__wrapper.is-focus) {
    border-color: color-mix(in srgb, var(--brand-primary) 32%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand-primary) 12%, transparent);
  }

  :deep(.el-cascader .el-input__inner) {
    height: 2rem;
    color: var(--brand-text-primary);
    font-size: 0.8125rem;
  }

  :deep(.el-cascader .el-input__inner::placeholder) {
    color: var(--brand-text-secondary);
  }

  :deep(.el-cascader .el-input__suffix) {
    color: var(--brand-text-secondary);
  }

  &.is-disabled {
    cursor: not-allowed;
  }
}

:global(.chat-model-trigger__popper) {
  border-radius: 0.5rem;
  box-shadow: var(--brand-shadow-hairline);
}

:global(.chat-model-trigger__popper .el-cascader-menu) {
  min-width: 8.5rem;
}

:global(.chat-model-trigger__popper .el-cascader-menu:first-child) {
  min-width: 6.5rem;
}

:global(.chat-model-trigger__popper .el-cascader-menu:last-child) {
  min-width: 9.5rem;
}

:global(.chat-model-trigger__popper .el-cascader-node) {
  min-height: 1.875rem;
  padding-inline: 0.5rem 0.375rem;
  font-size: 0.8125rem;
}

:global(.chat-model-trigger__popper .el-cascader-node.in-active-path),
:global(.chat-model-trigger__popper .el-cascader-node.is-active) {
  background: color-mix(in srgb, var(--brand-primary) 8%, transparent);
}

:global(.chat-model-trigger__popper .el-cascader-node__prefix + .el-cascader-node__label .model-cascader__node) {
  margin-left: 0.875rem;
}
</style>
