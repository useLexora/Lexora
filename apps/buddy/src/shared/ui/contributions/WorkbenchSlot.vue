<script setup lang="ts">
import type { WorkbenchSlot } from '@buddy-shared/workbench/workbenchUi'
import { useOptionalWorkbenchUi } from './workbenchUiContext'

defineProps<{ target: WorkbenchSlot }>()
defineSlots<{ default: () => unknown }>()
const host = useOptionalWorkbenchUi()
</script>

<template>
  <component :is="host.slotRenderer" v-if="host" :target="target">
    <slot />
  </component>
  <slot v-else />
</template>
