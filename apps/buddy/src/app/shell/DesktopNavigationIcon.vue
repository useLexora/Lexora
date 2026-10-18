<script setup lang="ts">
import type { DesktopNavigationEntry } from '@/shared/navigation/desktopPages'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'

defineProps<{ icon: DesktopNavigationEntry['icon'] }>()
</script>

<template>
  <DesktopPluginIcon v-if="icon.kind === 'plugin'" :src="icon.url" />
  <DesktopIcon v-else-if="icon.kind === 'named'" :name="icon.name" />
  <DesktopIcon v-else class="flex-none origin-center [transform:translateY(-0.025em)_scale(1.12)]" :component="icon.component" />
</template>
