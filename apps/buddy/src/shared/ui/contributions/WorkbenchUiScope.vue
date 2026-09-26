<script setup lang="ts">
import { useProvideWorkbenchUiScope } from './workbenchUiContext'

const props = defineProps<{ instanceId?: string }>()
useProvideWorkbenchUiScope({ instanceId: () => props.instanceId })
</script>

<template>
  <slot />
</template>
