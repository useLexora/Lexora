<script setup lang="ts">
import type { SpaceDirectorySource } from '@buddy-electron/shared/localChatApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronDown16Regular } from '@vicons/fluent'
import { NButton, NButtonGroup, NDropdown } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

// One button for picking a directory. Without WSL it is a plain button; with WSL the arrow lists where to pick from.
const props = defineProps<{
  disabled: boolean
  distributions: readonly string[]
  label: string
  language: BuddyLocale
  quaternary?: boolean
  size?: 'tiny' | 'small' | 'medium'
}>()
const emit = defineEmits<{ select: [source?: SpaceDirectorySource] }>()
const { t } = useBuddyI18n(() => props.language)
const options = computed(() => [
  { key: '', label: t('desktop.tasks.directorySourceLocal') },
  ...props.distributions.map(name => ({ key: name, label: `WSL · ${name}…` })),
])

function choose(key: string) {
  emit('select', key ? { wsl: key } : undefined)
}
</script>

<template>
  <NButtonGroup v-if="distributions.length > 0">
    <NButton :quaternary="quaternary" :size="size" :disabled="disabled" @click="emit('select')">
      <template v-if="$slots.icon" #icon>
        <slot name="icon" />
      </template>
      {{ label }}
    </NButton>
    <NDropdown trigger="click" placement="bottom-end" :options="options" :disabled="disabled" @select="choose">
      <NButton :quaternary="quaternary" :size="size" :disabled="disabled" :aria-label="t('desktop.tasks.directorySourceMenu')">
        <DesktopIcon :component="ChevronDown16Regular" :size="14" />
      </NButton>
    </NDropdown>
  </NButtonGroup>
  <NButton v-else :quaternary="quaternary" :size="size" :disabled="disabled" @click="emit('select')">
    <template v-if="$slots.icon" #icon>
      <slot name="icon" />
    </template>
    {{ label }}
  </NButton>
</template>
