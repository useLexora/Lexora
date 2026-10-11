<script setup lang="ts">
import type { ReasoningFieldState } from './typing'
import { useTemplateRef } from 'vue'
import { useReasoningFieldCanvas } from './reasoning-field/useReasoningFieldCanvas'

const props = defineProps<ReasoningFieldState>()
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
useReasoningFieldCanvas(canvas, props)
</script>

<template>
  <canvas ref="canvas" class="desktop-reasoning-field-canvas absolute inset-0 w-full h-full pointer-events-none" />
</template>
