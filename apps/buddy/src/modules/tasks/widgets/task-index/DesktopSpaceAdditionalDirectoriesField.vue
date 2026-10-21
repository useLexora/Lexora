<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { TaskSpacePrimaryDirectoryInput } from '@/modules/tasks/state/task-index/typing'
import { Add16Regular, Folder20Regular } from '@vicons/fluent'
import { NButton, NInput } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  directories: readonly TaskSpacePrimaryDirectoryInput[]
  disabled: boolean
  limitReached: boolean
  language: BuddyLocale
}>()
const emit = defineEmits<{ add: [], remove: [index: number] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="desktop-space-additional-directories grid w-full min-w-0 gap-[0.55rem]">
    <div class="grid gap-[0.1rem]">
      <div class="flex items-center justify-between gap-3">
        <strong class="text-[0.82rem] font-600">{{ t('desktop.tasks.spaceAdditionalDirectories') }}</strong>
        <NButton quaternary size="tiny" class="shrink-0" :disabled="disabled || limitReached" @click="emit('add')">
          <template #icon>
            <DesktopIcon :component="Add16Regular" :size="14" />
          </template>
          {{ t('desktop.tasks.addSpaceDirectory') }}
        </NButton>
      </div>
      <small class="text-muted text-[0.7rem] leading-[1.5]">{{ t('desktop.tasks.spaceAdditionalDirectoriesDescription') }}</small>
    </div>
    <div class="grid max-h-[12rem] gap-2 overflow-y-auto">
      <div v-for="(directory, index) in directories" :key="directory.id ?? directory.root" class="flex min-w-0 items-center gap-2">
        <NInput readonly :value="directory.root" class="min-w-0 flex-1">
          <template #prefix>
            <DesktopIcon :component="Folder20Regular" />
          </template>
        </NInput>
        <NButton :disabled="disabled" @click="emit('remove', index)">
          {{ t('desktop.tasks.removeSpaceWorkingDirectory') }}
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-space-additional-directories :deep(.n-input__input-el) {
  font-family: var(--buddy-font-mono);
  font-size: 0.75rem;
}
</style>
