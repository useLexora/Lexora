<script setup lang="ts">
import { NButton, NCheckbox, NModal } from 'naive-ui'
import { shallowRef, watch } from 'vue'

interface FullAccessConfirmationText {
  acknowledgement: string
  cancelLabel: string
  confirmLabel: string
  description: string
  title: string
}

defineProps<{
  text: FullAccessConfirmationText
}>()
const emit = defineEmits<{
  confirm: []
}>()
const show = defineModel<boolean>('show', { required: true })
const acknowledged = shallowRef(false)

watch(show, (open) => {
  if (open)
    acknowledged.value = false
})

function cancel() {
  show.value = false
}

function confirm() {
  if (!acknowledged.value)
    return
  show.value = false
  emit('confirm')
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="dialog"
    type="error"
    class="desktop-full-access-confirmation"
    :style="{ width: 'min(25rem, calc(100vw - 2rem))' }"
    :closable="false"
    :mask-closable="false"
    :title="text.title"
  >
    <p class="desktop-full-access-confirmation__description">
      {{ text.description }}
    </p>
    <NCheckbox v-model:checked="acknowledged" class="desktop-full-access-confirmation__acknowledgement">
      {{ text.acknowledgement }}
    </NCheckbox>

    <template #action>
      <div class="desktop-full-access-confirmation__actions">
        <NButton @click="cancel">
          {{ text.cancelLabel }}
        </NButton>
        <NButton type="error" :disabled="!acknowledged" @click="confirm">
          {{ text.confirmLabel }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-full-access-confirmation__description {
  margin: 0;
  color: var(--buddy-text-secondary);
  font-size: 0.86rem;
  line-height: 1.7;
}

.desktop-full-access-confirmation__acknowledgement {
  margin-top: 1rem;
  color: var(--buddy-text-primary);
  font-size: 0.84rem;
}

.desktop-full-access-confirmation__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
</style>
