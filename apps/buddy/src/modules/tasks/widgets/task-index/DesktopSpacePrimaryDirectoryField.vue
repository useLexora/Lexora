<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'

import type { SpaceDirectorySource, TaskSpacePrimaryDirectoryInput } from '@/modules/tasks/state/task-index/typing'
import { NButton } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopDirectoryPathInput from './DesktopDirectoryPathInput.vue'
import DesktopDirectorySourceButton from './DesktopDirectorySourceButton.vue'

const props = defineProps<{
  disabled: boolean
  language: BuddyLocale
  primaryDirectory: TaskSpacePrimaryDirectoryInput | null
  wslDistributions: readonly string[]
}>()
const emit = defineEmits<{
  removePrimary: []
  selectPrimary: [source?: SpaceDirectorySource]
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
      <DesktopDirectoryPathInput
        class="desktop-space-primary-directory__input"
        :placeholder="t('desktop.tasks.spaceManagedWorkspace')"
        :root="primaryDirectory?.root ?? ''"
      />
      <DesktopDirectorySourceButton
        v-if="!primaryDirectory"
        :disabled="disabled"
        :distributions="wslDistributions"
        :label="t('desktop.tasks.selectSpaceWorkingDirectory')"
        :language="language"
        @select="emit('selectPrimary', $event)"
      />
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
</style>
