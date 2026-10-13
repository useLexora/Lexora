<script setup lang="ts">
import { NEllipsis, NTag } from 'naive-ui'

defineProps<{ tags: string[] }>()
</script>

<template>
  <NEllipsis v-if="tags.length" class="h-[22px] min-w-0 flex-none leading-[22px]" data-testid="extension-tags">
    <span class="inline-flex items-center gap-[6px] align-top">
      <NTag v-for="tag in tags" :key="tag" size="small" :bordered="false">
        {{ tag }}
      </NTag>
    </span>
    <template #tooltip>
      <div role="tooltip" class="max-w-[280px] whitespace-normal [overflow-wrap:anywhere]">
        {{ tags.join(' · ') }}
      </div>
    </template>
  </NEllipsis>
</template>
