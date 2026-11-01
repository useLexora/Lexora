<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { SpaceDirectorySource, TaskSpacePrimaryDirectoryInput } from '@/modules/tasks/state/task-index/typing'
import { Add16Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopDirectoryPathInput from './DesktopDirectoryPathInput.vue'
import DesktopDirectorySourceButton from './DesktopDirectorySourceButton.vue'

const props = defineProps<{
  directories: readonly TaskSpacePrimaryDirectoryInput[]
  disabled: boolean
  limitReached: boolean
  language: BuddyLocale
  wslDistributions: readonly string[]
}>()
const emit = defineEmits<{ add: [source?: SpaceDirectorySource], remove: [index: number] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div class="desktop-space-additional-directories grid w-full min-w-0 gap-[0.55rem]">
    <div class="grid gap-[0.1rem]">
      <div class="flex items-center justify-between gap-3">
        <strong class="text-[0.82rem] font-600">{{ t('desktop.tasks.spaceAdditionalDirectories') }}</strong>
        <DesktopDirectorySourceButton
          class="shrink-0"
          quaternary
          size="tiny"
          :disabled="disabled || limitReached"
          :distributions="wslDistributions"
          :label="t('desktop.tasks.addSpaceDirectory')"
          :language="language"
          @select="emit('add', $event)"
        >
          <template #icon>
            <DesktopIcon :component="Add16Regular" :size="14" />
          </template>
        </DesktopDirectorySourceButton>
      </div>
      <small class="text-muted text-[0.7rem] leading-[1.5]">{{ t('desktop.tasks.spaceAdditionalDirectoriesDescription') }}</small>
    </div>
    <p v-if="directories.length === 0" class="m-0 rounded-[6px] border border-dashed border-[var(--buddy-border-subtle)] px-3 py-2 text-center text-muted text-[0.72rem]">
      {{ t('desktop.tasks.spaceAdditionalDirectoriesEmpty') }}
    </p>
    <div v-else class="grid max-h-[12rem] gap-2 overflow-y-auto">
      <div v-for="(directory, index) in directories" :key="directory.id ?? directory.root" class="flex min-w-0 items-center gap-2">
        <DesktopDirectoryPathInput :root="directory.root" class="min-w-0 flex-1" />
        <NButton :disabled="disabled" @click="emit('remove', index)">
          {{ t('desktop.tasks.removeSpaceWorkingDirectory') }}
        </NButton>
      </div>
    </div>
  </div>
</template>
