<script setup lang="ts">
import type { LinkPreviewController } from './useLinkPreview'
import { useClipboard } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import CopyStateIcon from '@/components/copy-state-icon/CopyStateIcon.vue'
import { SvgIcon } from '@/components/svg-icon'
import { ElMessage } from '@/utils/element-plus'

interface LinkPreviewProps {
  controller: LinkPreviewController
}

const props = defineProps<LinkPreviewProps>()
const { t } = useI18n()
const { copy, copied, isSupported } = useClipboard({
  legacy: true,
})

async function copyHref() {
  if (!props.controller.href.value) {
    return
  }

  if (!isSupported.value) {
    ElMessage.error(t('editor.common.copyUnsupported'))
    return
  }

  try {
    await copy(props.controller.href.value)
  }
  catch {
    ElMessage.error(t('editor.common.copyFailed'))
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="controller.isOpen.value"
      :ref="controller.assignPreviewRef"
      class="tiptap-link-preview"
      :style="controller.style.value"
      @mouseenter="controller.handlePreviewMouseEnter"
      @mouseleave="controller.handlePreviewMouseLeave"
      @mousedown.stop
    >
      <div
        class="tiptap-link-preview__href"
        :title="controller.href.value"
      >
        <SvgIcon category="ui" icon="link" size="1rem" />
        <span>{{ controller.href.value }}</span>
      </div>

      <button
        type="button"
        class="tiptap-link-preview__icon-btn"
        :aria-label="t('editor.common.copy')"
        @click="copyHref"
        @mousedown.prevent
      >
        <CopyStateIcon :copied="copied" size="1rem" />
      </button>

      <button
        type="button"
        class="tiptap-link-preview__edit-btn"
        @click="controller.edit"
        @mousedown.prevent
      >
        <SvgIcon category="ui" icon="edit" size="1rem" />
        <span>{{ t('editor.common.edit') }}</span>
      </button>
    </div>
  </Teleport>
</template>
