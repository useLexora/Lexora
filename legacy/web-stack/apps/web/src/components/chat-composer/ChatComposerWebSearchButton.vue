<script setup lang="ts">
import type {
  ChatComposerWebSearchButtonEmits,
  ChatComposerWebSearchButtonProps,
} from './typing'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<ChatComposerWebSearchButtonProps>()
const emit = defineEmits<ChatComposerWebSearchButtonEmits>()
const { t } = useI18n({ useScope: 'global' })

const webSearchToggleDisabled = computed(() => Boolean(props.disabled || props.isStreaming))
const webSearchToggleTooltip = computed(() =>
  props.webSearchForRunEnabled
    ? t('chat.composer.disableWebSearch')
    : t('chat.composer.enableWebSearch'),
)

function toggleWebSearchForRun() {
  if (webSearchToggleDisabled.value) {
    return
  }

  emit('update:webSearchForRunEnabled', !props.webSearchForRunEnabled)
}
</script>

<template>
  <ElTooltip
    v-if="props.webSearchSkillEnabled"
    :content="webSearchToggleTooltip"
    placement="top"
  >
    <span>
      <button
        class="chat-composer-toolbar__icon-button chat-composer-toolbar__web-search-button"
        :class="{ 'is-active': props.webSearchForRunEnabled }"
        type="button"
        :disabled="webSearchToggleDisabled"
        :aria-label="webSearchToggleTooltip"
        :aria-pressed="props.webSearchForRunEnabled"
        @click="toggleWebSearchForRun"
      >
        <SvgIcon category="ui" icon="globe" size="1rem" />
      </button>
    </span>
  </ElTooltip>
</template>
