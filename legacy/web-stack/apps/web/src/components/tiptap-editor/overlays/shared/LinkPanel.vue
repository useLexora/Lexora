<script setup lang="ts">
import type { LinkPanelController } from './useLinkPanel'
import { useI18n } from 'vue-i18n'
import { SvgIcon } from '@/components/svg-icon'
import { useLinkPanelView } from './useLinkPanelView'

interface LinkPanelProps {
  controller: LinkPanelController
}

const props = defineProps<LinkPanelProps>()
const view = useLinkPanelView(props.controller)
const { t } = useI18n()
</script>

<template>
  <div
    v-if="controller.isOpen.value"
    class="tiptap-link-panel"
    :class="`tiptap-link-panel--${controller.mode.value}`"
    @mousedown.stop
  >
    <template v-if="controller.mode.value === 'existing-link'">
      <label class="tiptap-link-panel__field">
        <span class="tiptap-link-panel__label">{{ t('editor.linkPanel.title') }}</span>
        <ElInput
          :ref="view.assignPrimaryInputRef"
          :model-value="controller.linkUrl.value"
          class="tiptap-link-panel__url-input"
          :placeholder="t('editor.linkPanel.hrefPlaceholder')"
          @keydown="view.handleInputKeydown"
          @update:model-value="controller.updateLinkUrl"
        />
      </label>

      <label class="tiptap-link-panel__field">
        <span class="tiptap-link-panel__label">{{ t('editor.linkPanel.label') }}</span>
        <ElInput
          :ref="view.assignSecondaryInputRef"
          :model-value="controller.linkText.value"
          :placeholder="t('editor.linkPanel.textPlaceholder')"
          @focus="controller.highlightLinkedText"
          @keydown="view.handleInputKeydown"
          @update:model-value="controller.updateLinkText"
        />
      </label>

      <button
        type="button"
        class="tiptap-link-panel__remove-row"
        @click="controller.remove"
      >
        <SvgIcon category="ui" icon="trash-can" size="1rem" />
        <span>{{ t('editor.linkPanel.remove') }}</span>
      </button>
    </template>

    <template v-else>
      <ElInput
        v-if="controller.mode.value === 'empty-block'"
        :ref="view.assignPrimaryInputRef"
        :model-value="controller.linkText.value"
        :placeholder="t('editor.linkPanel.textPlaceholder')"
        @keydown="view.handleInputKeydown"
        @update:model-value="controller.updateLinkText"
      />

      <ElInput
        :ref="controller.mode.value === 'selection'
          ? view.assignPrimaryInputRef
          : view.assignSecondaryInputRef"
        :model-value="controller.linkUrl.value"
        class="tiptap-link-panel__url-input"
        :placeholder="t('editor.linkPanel.hrefPlaceholder')"
        @keydown="view.handleInputKeydown"
        @update:model-value="controller.updateLinkUrl"
      />
    </template>

    <div
      v-if="controller.mode.value !== 'existing-link'"
      class="tiptap-link-panel__actions"
    >
      <ElButton
        size="small"
        type="primary"
        :disabled="controller.isConfirmDisabled.value"
        @click="controller.apply"
      >
        {{ t('editor.common.confirm') }}
      </ElButton>

      <ElButton
        v-if="controller.mode.value === 'selection' && controller.canRemove.value"
        size="small"
        @click="controller.remove"
      >
        {{ t('editor.common.remove') }}
      </ElButton>

      <ElButton
        size="small"
        @click="controller.cancel"
      >
        {{ t('editor.common.cancel') }}
      </ElButton>
    </div>
  </div>
</template>
