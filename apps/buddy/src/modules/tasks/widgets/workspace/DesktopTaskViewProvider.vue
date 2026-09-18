<script setup lang="ts">
import type { TaskContext } from '../../taskContext'
import { useProvideTaskContext } from '../../taskContext'

const props = defineProps<{ context: TaskContext }>()
useProvideTaskContext(props.context)
</script>

<template>
  <slot />
</template>
