<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ text: string, name: string }>()
defineEmits<{ error: [] }>()
const url = computed(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.text)}`)
</script>

<template>
  <div class="grid flex-1 min-h-0 overflow-auto p-[16px] place-items-center">
    <img :src="url" :alt="name" class="max-w-full max-h-full object-contain" @error="$emit('error')">
  </div>
</template>
