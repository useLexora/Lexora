<script setup lang="ts">
import { parseWslPath } from '@buddy-shared/files/wslPath'
import { Folder20Regular } from '@vicons/fluent'
import { NInput } from 'naive-ui'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

// A directory shown as the path the user knows: a WSL directory is its distribution tag plus the Linux path, the real path stays in the tooltip.
const props = defineProps<{ placeholder?: string, root: string }>()
const wsl = computed(() => parseWslPath(props.root))
</script>

<template>
  <NInput class="desktop-directory-path" readonly :placeholder="placeholder" :title="root" :value="wsl ? wsl.linuxPath : root">
    <template #prefix>
      <span v-if="wsl" class="desktop-directory-path__tag">WSL · {{ wsl.distribution }}</span>
      <DesktopIcon v-else :component="Folder20Regular" />
    </template>
  </NInput>
</template>

<style scoped>
.desktop-directory-path :deep(.n-input__input-el) {
  font-family: var(--buddy-font-mono);
  font-size: 0.75rem;
}

.desktop-directory-path__tag {
  margin-right: 0.15rem;
  padding: 0 0.4rem;
  border: 1px solid var(--buddy-border-subtle);
  border-radius: 999px;
  color: var(--buddy-text-secondary);
  font-size: 0.68rem;
  line-height: 1.35rem;
  white-space: nowrap;
}
</style>
