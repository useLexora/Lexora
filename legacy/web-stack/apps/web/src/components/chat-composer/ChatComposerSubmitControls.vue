<script setup lang="ts">
import type {
  ChatComposerSubmitControlsEmits,
  ChatComposerSubmitControlsProps,
} from './typing'
import { CloseBold, Loading } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ChatModelTrigger from './ChatModelTrigger.vue'

const props = defineProps<ChatComposerSubmitControlsProps>()
const emit = defineEmits<ChatComposerSubmitControlsEmits>()
const { t } = useI18n({ useScope: 'global' })
const tooltipContent = computed(() => {
  if (props.isStreaming) {
    return t('chat.composer.stop')
  }

  if (props.isSubmitting) {
    return t('chat.composer.sending')
  }

  return t('chat.composer.send')
})
</script>

<template>
  <div class="chat-composer-toolbar__right">
    <ChatModelTrigger
      :selected-model-ref="props.selectedModelRef"
      :selection-kind="props.modelSelectionKind"
      :disabled="props.isStreaming || props.isSubmitting"
      @select="emit('selectModel', $event)"
    />

    <ElTooltip :content="tooltipContent" placement="top">
      <button
        v-if="props.isStreaming"
        class="chat-composer-toolbar__send-button is-stop"
        type="button"
        :aria-label="t('chat.composer.stop')"
        @click="emit('stop')"
      >
        <ElIcon><CloseBold /></ElIcon>
      </button>
      <button
        v-else
        class="chat-composer-toolbar__send-button"
        type="button"
        :disabled="props.disabled || props.isSubmitting || !props.canSend"
        :aria-label="tooltipContent"
        @click="emit('send')"
      >
        <ElIcon v-if="props.isSubmitting" class="chat-composer-toolbar__sending-icon">
          <Loading />
        </ElIcon>
        <SvgIcon v-else category="ui" icon="send-light" size="1rem" />
      </button>
    </ElTooltip>
  </div>
</template>

<style scoped lang="scss">
.chat-composer-toolbar__sending-icon {
  animation: chat-composer-sending-spin 880ms linear infinite;
}

@keyframes chat-composer-sending-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}
</style>
