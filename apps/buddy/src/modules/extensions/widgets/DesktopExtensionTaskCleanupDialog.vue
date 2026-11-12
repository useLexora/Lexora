<script setup lang="ts">
import type { ExtensionTaskCleanupConfirmation } from '@buddy-shared/extensions/extensionTaskCleanup'
import { Delete20Regular } from '@vicons/fluent'
import { NAlert, NButton, NModal } from 'naive-ui'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { extensionTaskCleanupLabels } from '../state/extensionTaskCleanupLabels'

const props = defineProps<{
  confirmation: ExtensionTaskCleanupConfirmation
  name: string
  language: string
  busy: boolean
  error: string | null
}>()
const emit = defineEmits<{ confirm: [confirmed: boolean] }>()
const labels = computed(() => extensionTaskCleanupLabels(props.language))
</script>

<template>
  <NModal :show="true" preset="card" class="w-[min(32rem,calc(100vw-2rem))]" :bordered="false" :closable="!busy" :mask-closable="false" :close-on-esc="!busy" data-testid="extension-task-cleanup-dialog" @update:show="!$event && !busy && emit('confirm', false)">
    <template #header>
      <div class="flex items-center gap-2">
        <DesktopIcon :component="Delete20Regular" :size="20" class="text-muted" />
        <span>{{ labels.title }}</span>
      </div>
    </template>
    <div class="flex flex-col gap-5">
      <p class="m-0 text-xs text-muted">
        {{ name }}
      </p>
      <div class="flex items-baseline gap-2" data-testid="extension-task-cleanup-scope">
        <strong class="text-3xl font-semibold text-fg">{{ confirmation.total }}</strong>
        <span class="text-sm text-muted">{{ labels.scope }}</span>
      </div>
      <NAlert type="warning" :show-icon="false" :title="labels.irreversible">
        {{ labels.risk }}
      </NAlert>
      <p class="m-0 text-xs leading-5 text-muted">
        {{ labels.changed }}
      </p>
      <p v-if="confirmation.skipped" class="m-0 text-xs leading-5 text-muted">
        {{ labels.skipped(confirmation.skipped) }}
      </p>
      <NAlert v-if="error" type="error" :show-icon="false" role="alert">
        {{ error }}
      </NAlert>
    </div>
    <template #footer>
      <div class="flex flex-wrap justify-end gap-2">
        <NButton :disabled="busy" autofocus @click="emit('confirm', false)">
          {{ labels.cancel }}
        </NButton>
        <NButton type="error" :loading="busy" @click="emit('confirm', true)">
          {{ labels.delete }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>
