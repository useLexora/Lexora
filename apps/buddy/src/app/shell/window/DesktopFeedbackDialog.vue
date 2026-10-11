<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'

import { Open20Regular } from '@vicons/fluent'
import { NButton, NInput, NModal } from 'naive-ui'
import { shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  show: boolean
}>()
const emit = defineEmits<{
  'openGithubIssue': [feedback: string]
  'update:show': [show: boolean]
}>()

const feedback = shallowRef('')
const { t } = useBuddyI18n(() => props.language)

watch(() => props.show, (show) => {
  if (show)
    feedback.value = ''
})
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="desktop-feedback-dialog"
    :style="{ width: 'min(31rem, calc(100vw - 2rem))' }"
    :title="t('desktop.feedback.title')"
    @update:show="emit('update:show', $event)"
  >
    <div class="desktop-feedback-dialog__channels flex items-center justify-between gap-4 mb-[0.9rem] border-b-1 border-b-solid border-b-border pb-[0.55rem]">
      <span aria-current="page">{{ t('desktop.feedback.write') }}</span>
      <NButton text type="primary" @click="emit('openGithubIssue', '')">
        {{ t('desktop.feedback.githubIssue') }}
        <template #icon>
          <DesktopIcon :component="Open20Regular" />
        </template>
      </NButton>
    </div>
    <p>{{ t('desktop.feedback.description') }}</p>
    <NInput
      v-model:value="feedback"
      type="textarea"
      :autosize="{ minRows: 6, maxRows: 10 }"
      :placeholder="t('desktop.feedback.placeholder')"
    />
    <template #footer>
      <div class="flex justify-end gap-[0.6rem]">
        <NButton @click="emit('update:show', false)">
          {{ t('common.cancel') }}
        </NButton>
        <NButton type="primary" @click="emit('openGithubIssue', feedback)">
          {{ t('desktop.feedback.continueInGithub') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-feedback-dialog__channels > span {
  color: var(--buddy-text-strong);
  font-size: 0.78rem;
  font-weight: 600;
}

.desktop-feedback-dialog p {
  margin: 0 0 0.9rem;
  color: var(--buddy-text-secondary);
  font-size: 0.82rem;
  line-height: 1.6;
}
</style>
