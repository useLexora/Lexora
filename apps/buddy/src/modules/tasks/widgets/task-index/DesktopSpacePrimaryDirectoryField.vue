<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'

import type { TaskSpacePrimaryDirectoryInput } from '@/modules/tasks/state/task-index/typing'
import { Folder20Regular } from '@vicons/fluent'
import { NButton, NInput } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  disabled: boolean
  language: BuddyLocale
  primaryDirectory: TaskSpacePrimaryDirectoryInput | null
}>()
const emit = defineEmits<{
  removePrimary: []
  selectPrimary: []
}>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="desktop-space-primary-directory w-full gap-[0.55rem]">
    <div class="desktop-space-primary-directory__header gap-[0.1rem]">
      <strong>{{ t('desktop.tasks.spaceWorkingDirectory') }}</strong>
      <small>{{ t('desktop.tasks.spaceWorkingDirectoryDescription') }}</small>
    </div>

    <div class="flex items-center gap-2">
      <NInput
        class="desktop-space-primary-directory__input"
        readonly
        :placeholder="t('desktop.tasks.spaceManagedWorkspace')"
        :value="primaryDirectory?.root ?? ''"
      >
        <template #prefix>
          <DesktopIcon :component="Folder20Regular" />
        </template>
      </NInput>
      <NButton
        v-if="!primaryDirectory"
        :disabled="disabled"
        @click="emit('selectPrimary')"
      >
        {{ t('desktop.tasks.selectSpaceWorkingDirectory') }}
      </NButton>
      <NButton
        v-else
        :disabled="disabled"
        @click="emit('removePrimary')"
      >
        {{ t('desktop.tasks.removeSpaceWorkingDirectory') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-space-primary-directory,
.desktop-space-primary-directory__header {
  display: grid;
}

.desktop-space-primary-directory__header strong {
  font-size: 0.82rem;
  font-weight: 600;
}

.desktop-space-primary-directory__header small {
  color: var(--buddy-text-secondary);
  font-size: 0.7rem;
  line-height: 1.5;
}

.desktop-space-primary-directory__input {
  min-width: 0;
  flex: 1;
}

.desktop-space-primary-directory__input :deep(.n-input__input-el) {
  font-family: var(--buddy-font-mono);
  font-size: 0.75rem;
}
</style>
