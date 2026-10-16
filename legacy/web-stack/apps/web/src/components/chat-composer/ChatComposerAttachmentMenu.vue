<script setup lang="ts">
import type {
  ChatComposerAttachmentMenuEmits,
  ChatComposerAttachmentMenuProps,
} from './typing'
import { Document, Picture } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<ChatComposerAttachmentMenuProps>()
const emit = defineEmits<ChatComposerAttachmentMenuEmits>()
const { t } = useI18n({ useScope: 'global' })

const uploadMenuDisabled = computed(() => Boolean(props.disabled || props.isStreaming))
const imageUploadDisabled = computed(() => Boolean(props.uploadAvailability?.image.disabled))
const fileUploadDisabled = computed(() => Boolean(props.uploadAvailability?.file.disabled))

function handleUploadCommand(command: string | number | object) {
  const commandValue = String(command)
  if (commandValue === 'image') {
    if (imageUploadDisabled.value) {
      return
    }
    emit('uploadImage')
    return
  }

  if (commandValue === 'file') {
    if (fileUploadDisabled.value) {
      return
    }
    emit('uploadFile')
  }
}
</script>

<template>
  <ElTooltip :content="t('chat.composer.addAttachment')" placement="top">
    <span>
      <ElDropdown
        trigger="click"
        :disabled="uploadMenuDisabled"
        @command="handleUploadCommand"
      >
        <button
          class="chat-composer-toolbar__icon-button"
          type="button"
          :disabled="uploadMenuDisabled"
          :aria-label="t('chat.composer.addAttachment')"
        >
          <SvgIcon category="ui" icon="plus" size="1rem" />
        </button>

        <template #dropdown>
          <ElDropdownMenu class="chat-composer-toolbar__upload-menu">
            <ElDropdownItem
              command="image"
              class="chat-composer-toolbar__upload-item"
              :disabled="imageUploadDisabled"
            >
              <ElTooltip
                :disabled="!imageUploadDisabled"
                :content="t('chat.composer.modelUnsupportedImageUpload')"
                placement="right"
                effect="dark"
              >
                <span class="chat-composer-toolbar__command-main">
                  <ElIcon><Picture /></ElIcon>
                  <span>{{ t('chat.composer.uploadImage') }}</span>
                </span>
              </ElTooltip>
            </ElDropdownItem>

            <ElDropdownItem
              command="file"
              class="chat-composer-toolbar__upload-item"
              :disabled="fileUploadDisabled"
            >
              <ElTooltip
                :disabled="!fileUploadDisabled"
                :content="t('chat.composer.modelUnsupportedFileUpload')"
                placement="right"
                effect="dark"
              >
                <span class="chat-composer-toolbar__command-main">
                  <ElIcon><Document /></ElIcon>
                  <span>{{ t('chat.composer.uploadFile') }}</span>
                </span>
              </ElTooltip>
            </ElDropdownItem>
          </ElDropdownMenu>
        </template>
      </ElDropdown>
    </span>
  </ElTooltip>

  <ElTooltip :content="t('chat.composer.selectDocument')" placement="top">
    <button
      class="chat-composer-toolbar__icon-button"
      type="button"
      :disabled="props.disabled"
      :aria-label="t('chat.composer.selectDocument')"
      @click="emit('openPanelPicker')"
    >
      <span class="chat-composer-toolbar__symbol">@</span>
    </button>
  </ElTooltip>
</template>
