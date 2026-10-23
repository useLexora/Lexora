<script setup lang="ts">
import { NEllipsis } from 'naive-ui'

defineProps<{ label: string, source: string, builtin: boolean }>()
</script>

<template>
  <span class="desktop-file-opening-option inline-flex w-full min-w-0 items-center gap-2 align-middle">
    <NEllipsis class="min-w-0 flex-1 text-[13px]">{{ label }}</NEllipsis>
    <span v-if="builtin" class="shrink-0 rounded-micro bg-subtle px-[5px] text-[10px] text-muted leading-[18px]">{{ source }}</span>
    <NEllipsis v-else-if="source" class="max-w-[45%] text-[11px] text-muted">{{ source }}</NEllipsis>
  </span>
</template>
