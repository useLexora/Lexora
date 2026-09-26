<script setup lang="ts">
import type { WorkbenchMenuProps } from './workbenchUiContext'
import { useOptionalWorkbenchUi } from './workbenchUiContext'

defineProps<WorkbenchMenuProps>()
const host = useOptionalWorkbenchUi()
</script>

<template>
  <component :is="host.menuRenderer" v-if="host" :target="target" :disabled="disabled" :values="values" :capture="capture" />
</template>
