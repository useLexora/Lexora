<script setup lang="ts">
import type { MathPanelController } from './useMathPanel'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMathPanelView } from './useMathPanelView'

interface MathPanelProps {
  controller: MathPanelController
}

const props = defineProps<MathPanelProps>()
const view = useMathPanelView(props.controller)
const { t } = useI18n()
const inputType = computed(() => props.controller.mode.value === 'block' ? 'textarea' : 'text')
const inputRows = computed(() => props.controller.mode.value === 'block' ? 4 : undefined)
</script>

<template>
  <div
    v-if="controller.isOpen.value"
    class="tiptap-math-panel"
    @mousedown.stop
  >
    <ElInput
      :ref="view.assignInputRef"
      :model-value="controller.draftLatex.value"
      class="tiptap-math-panel__input"
      :type="inputType"
      :rows="inputRows"
      :autosize="controller.mode.value === 'block' ? { minRows: 3, maxRows: 8 } : false"
      :placeholder="t('editor.math.placeholder')"
      @keydown="view.handleInputKeydown"
      @update:model-value="controller.updateDraftLatex"
    />

    <div class="tiptap-math-panel__actions">
      <ElButton size="small" type="primary" @click="controller.apply">
        {{ t('editor.common.confirm') }}
      </ElButton>

      <ElButton size="small" @click="controller.remove">
        {{ t('editor.common.remove') }}
      </ElButton>

      <ElButton size="small" @click="controller.cancel">
        {{ t('editor.common.cancel') }}
      </ElButton>
    </div>
  </div>
</template>
