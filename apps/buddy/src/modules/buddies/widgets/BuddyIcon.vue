<script setup lang="ts">
import { buddyIconEyes, buddyIconPaths, buddyToolbarStroke } from '@/shared/ui/icon/buddyIcon'

withDefaults(defineProps<{ variant?: 'navigation' | 'toolbar' }>(), { variant: 'navigation' })
</script>

<template>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="variant === 'toolbar' ? buddyToolbarStroke : 1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path v-for="path in buddyIconPaths" :key="path" :d="path" />
    <g fill="currentColor" stroke="none">
      <circle v-for="[x, y] in buddyIconEyes" :key="`${x}:${y}`" :cx="x" :cy="y" r=".85" />
    </g>
  </svg>
</template>
