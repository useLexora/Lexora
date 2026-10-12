<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'navigation' | 'toolbar' }>(), { variant: 'navigation' })
</script>

<template>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="variant === 'toolbar' ? 1.2 : 1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11.8 19.9c-5.9.7-9-1.8-9-6.3 0-5.1 3-9.9 7.1-9.9 3.8 0 6.1 3.3 6.6 6.9" />
    <path d="M16.3 10.6c3.2 0 5 3.1 5 6.7 0 2.5-1.9 3.4-5.1 3.4-3.1 0-5.1-.7-5.1-3.2 0-3.7 1.9-6.9 5.2-6.9Z" />
    <path d="M8.3 10.5c.8.7 2.1.7 3 0" />
    <g fill="currentColor" stroke="none">
      <circle cx="7.9" cy="8.2" r=".85" />
      <circle cx="11.8" cy="8.2" r=".85" />
      <circle cx="14.7" cy="15" r=".85" />
      <circle cx="18" cy="15" r=".85" />
    </g>
  </svg>
</template>
