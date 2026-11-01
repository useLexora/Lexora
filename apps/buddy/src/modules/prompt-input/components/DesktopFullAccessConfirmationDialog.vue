<script setup lang="ts">
import DesktopRiskConfirmationDialog from '@/shared/ui/confirmation/DesktopRiskConfirmationDialog.vue'

defineProps<{
  text: {
    acknowledgement: string
    cancelLabel: string
    confirmLabel: string
    description: string
    title: string
  }
}>()
const emit = defineEmits<{ confirm: [] }>()
const show = defineModel<boolean>('show', { required: true })
</script>

<template>
  <DesktopRiskConfirmationDialog v-model:show="show" class="desktop-full-access-confirmation" :text="text" @confirm="emit('confirm')" />
</template>
