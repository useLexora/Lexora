<script setup lang="ts">
import type { WorkbenchControlProps } from './workbenchUiContext'
import { useOptionalWorkbenchUi } from './workbenchUiContext'

const props = defineProps<WorkbenchControlProps>()
const emit = defineEmits<{ change: [value: string], dismiss: [] }>()
defineSlots<{ default: () => unknown }>()
const host = useOptionalWorkbenchUi()
</script>

<template>
  <component :is="host.controlRenderer" v-if="host" v-bind="props" @change="emit('change', $event)" @dismiss="emit('dismiss')">
    <slot />
  </component>
  <slot v-else />
</template>
