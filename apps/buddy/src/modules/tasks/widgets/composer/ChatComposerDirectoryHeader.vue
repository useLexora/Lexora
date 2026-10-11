<script setup lang="ts">
import type { BuddyComposerDirectory } from '@buddy-shared/conversation/composerResource'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { composerReferencePath } from '@buddy-shared/conversation/composerReferencePath'
import { NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { composerDirectoryBreadcrumbs, composerParentDirectory } from './chatComposerSourcePresentation'

const props = defineProps<{ directory: BuddyComposerDirectory, language: BuddyLocale }>()
const emit = defineEmits<{ navigate: [path: string] }>()
const { t } = useBuddyI18n(() => props.language)
const breadcrumbs = computed(() => composerDirectoryBreadcrumbs(props.directory))
const external = computed(() => composerReferencePath(props.directory.path, props.directory.workingDirectory) === props.directory.path)
const parent = computed(() => composerParentDirectory(props.directory))
</script>

<template>
  <div class="chat-composer-directory-header flex items-center gap-[0.3rem] min-w-0 pt-[0.35rem] pr-[0.4rem] pb-[0.15rem] pl-[0.4rem] text-muted text-[0.62rem]" @mousedown.prevent>
    <NTooltip v-if="directory.workingDirectory" :delay="400" to=".buddy-app">
      <template #trigger>
        <button class="chat-composer-directory-header__root flex-none" type="button" tabindex="-1" @click="emit('navigate', directory.workingDirectory)">
          {{ t(external ? 'desktop.chat.sourcePickerExternal' : 'desktop.chat.sourcePickerWorkspace') }}
        </button>
      </template>
      {{ directory.workingDirectory }}
    </NTooltip>
    <span v-else class="chat-composer-directory-header__root flex-none">{{ t('desktop.chat.sourcePickerDirectory') }}</span>
    <span v-if="external" class="overflow-hidden text-ellipsis whitespace-nowrap">{{ directory.path }}</span>
    <template v-for="crumb in breadcrumbs" :key="crumb.path">
      <span class="flex-none">›</span>
      <NTooltip :delay="400" to=".buddy-app">
        <template #trigger>
          <button type="button" tabindex="-1" @click="emit('navigate', crumb.path)">
            {{ crumb.name }}
          </button>
        </template>
        {{ crumb.path }}
      </NTooltip>
    </template>
    <button v-if="parent" class="flex-none ml-auto" type="button" tabindex="-1" @click="emit('navigate', parent)">
      {{ t('desktop.chat.sourcePickerParent') }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.chat-composer-directory-header {
  button {
    min-width: 0;
    overflow: hidden;
    padding: 0.1rem 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;

    &:hover { color: var(--buddy-text-strong); }
  }
}

.chat-composer-directory-header .chat-composer-directory-header__root {
  font-weight: 600;
}
</style>
