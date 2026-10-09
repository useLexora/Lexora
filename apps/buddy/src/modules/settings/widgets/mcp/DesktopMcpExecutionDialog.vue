<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NModal } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ connector: LocalConnector, language: BuddyLocale, busy: boolean }>()
const emit = defineEmits<{ close: [], confirm: [] }>()
const { t } = useBuddyI18n(() => props.language)
const target = computed(() => props.connector.transport === 'stdio'
  ? JSON.stringify({ command: props.connector.command, args: props.connector.args, ...(props.connector.cwd ? { cwd: props.connector.cwd } : {}) }, null, 2)
  : '')
</script>

<template>
  <NModal show preset="dialog" type="warning" :title="t('desktop.mcp.confirmExecutionTitle')" :closable="!busy" :mask-closable="!busy" @close="emit('close')" @update:show="value => !value && emit('close')">
    <p>{{ t('desktop.mcp.confirmExecutionDescription') }}</p>
    <pre class="mcp-execution__target">{{ target }}</pre>
    <template #action>
      <NButton :disabled="busy" @click="emit('close')">
        {{ t('common.cancel') }}
      </NButton>
      <NButton type="primary" :loading="busy" @click="emit('confirm')">
        {{ t('desktop.mcp.confirmExecution') }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped>
.mcp-execution__target { overflow-wrap: anywhere; white-space: pre-wrap; padding: 0.8rem; background: var(--buddy-surface-subtle); border-radius: 0.5rem; }
</style>
