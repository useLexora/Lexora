<script setup lang="ts">
withDefaults(defineProps<{ name?: string }>(), { name: 'spark' })

const paths: Record<string, string> = {
  spark: 'M12 2 15 9 22 12 15 15 12 22 9 15 2 12 9 9Z',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  external: 'M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6',
  down: 'M12 4v16m-6-6 6 6 6-6',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  check: 'm5 12 4 4L19 6',
  file: 'M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8Zm0 0v6h6M8 13h8M8 17h5',
  clock: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  globe: 'M2 12h20M12 2c6 5 6 15 0 20-6-5-6-15 0-20Zm10 10a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm5 5 14 14M5 19 19 5',
  chevron: 'm9 5 7 7-7 7',
  replay: 'M3 10a9 9 0 1 1 2 9M3 4v6h6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M20.5 14A9 9 0 0 1 10 3.5a9 9 0 1 0 10.5 10.5Z',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  chat: 'M21 11a9 9 0 0 1-9 9H4l-3 2 2-6a9 9 0 1 1 18-5ZM7 10h10M7 14h6',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5',
}
</script>

<template>
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name] || paths.spark" />
  </svg>
</template>
