<script setup lang="ts">
import { NButton, NModal } from 'naive-ui'
import { computed, useTemplateRef, watch } from 'vue'
import { extensionLabels } from '../extensionLabels'

const props = defineProps<{ name: string, language: string, busy: boolean }>()
const emit = defineEmits<{ cancel: [], remove: [clearData: boolean] }>()
const labels = computed(() => extensionLabels(props.language))
const cancelButton = useTemplateRef<InstanceType<typeof NButton>>('cancelButton')
watch(cancelButton, button => button?.$el.focus(), { flush: 'post' })
</script>

<template>
  <NModal show preset="dialog" type="warning" :title="labels.removeTitle" :auto-focus="false" :closable="!busy" :mask-closable="!busy" :close-on-esc="!busy" @close="emit('cancel')" @mask-click="!busy && emit('cancel')" @esc="!busy && emit('cancel')">
    <p>{{ name }} · {{ labels.retained }}</p>
    <p class="text-muted text-[0.78rem]">
      {{ labels.cleanupHint }}
    </p>
    <template #action>
      <div class="flex w-full gap-2">
        <NButton class="extension-uninstall__cleanup" quaternary type="error" :disabled="busy" @click="emit('remove', true)">
          {{ labels.removeAndClear }}
        </NButton>
        <NButton ref="cancelButton" :disabled="busy" @click="emit('cancel')">
          {{ labels.cancel }}
        </NButton>
        <NButton type="error" :disabled="busy" @click="emit('remove', false)">
          {{ labels.remove }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.extension-uninstall__cleanup { margin-right: auto; }
</style>
