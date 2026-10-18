<script setup lang="ts">
import type { DesktopNavigationEntry } from '@/shared/navigation/desktopPages'
import { NTooltip } from 'naive-ui'
import DesktopNavigationIcon from './DesktopNavigationIcon.vue'

defineProps<{ entry: DesktopNavigationEntry, iconOnly?: boolean, dense?: boolean }>()
defineEmits<{ navigate: [id: string] }>()
</script>

<template>
  <NTooltip class="pointer-events-none" :disabled="!iconOnly" :placement="dense ? 'top' : 'right'">
    <template #trigger>
      <button
        class="desktop-app-sidebar__nav-item flex flex-none items-center border-0 rounded-icon cursor-pointer text-sidebar-item [font-weight:var(--buddy-sidebar-item-font-weight)] leading-[20px] ui-focus-ring transition-state-colors"
        :class="[
          iconOnly ? [dense ? 'size-7' : 'size-8', 'justify-center p-0'] : 'w-full min-h-9 gap-[0.625rem] py-2 px-[0.625rem] text-left',
          entry.active ? 'is-active bg-nav-selected text-nav-foreground hover:bg-nav-selected-hover active:bg-nav-pressed' : 'bg-transparent text-app-sidebar-fg hover:(bg-hover text-strong) active:bg-nav-pressed',
        ]"
        :aria-label="iconOnly ? entry.title : undefined"
        :aria-current="entry.active ? 'page' : undefined"
        :data-extension-navigation="entry.extensionId"
        :data-navigation-id="entry.id"
        type="button"
        @click="$emit('navigate', entry.id)"
      >
        <DesktopNavigationIcon :icon="entry.icon" />
        <span v-if="!iconOnly">{{ entry.title }}</span>
      </button>
    </template>
    {{ entry.title }}
  </NTooltip>
</template>
