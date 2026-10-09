<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NSwitch, NTag, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ connector: LocalConnector, language: BuddyLocale, busy: boolean, codemodeEnabled: boolean }>()
const emit = defineEmits<{ toggle: [enabled: boolean], reconnect: [], tools: [], login: [], cancelLogin: [], runtime: [] }>()
const { t } = useBuddyI18n(() => props.language)
const authenticating = computed(() => props.connector.runtime.status === 'authenticating')
const canLogin = computed(() => props.connector.runtime.authorization === 'oauth'
  && ['MCP_AUTHENTICATION_REQUIRED', 'MCP_AUTHENTICATION_FAILED', 'MCP_AUTHENTICATION_CANCELLED', 'MCP_ACCESS_DENIED'].includes(props.connector.runtime.errorCode ?? ''))
const cachedTools = computed(() => props.connector.runtime.updatedAt !== null && props.connector.runtime.status !== 'ready')
const showStatusTag = computed(() => {
  if (!props.connector.enabled)
    return false
  return props.connector.runtime.status !== 'ready' || Boolean(props.connector.runtime.errorCode)
})
const canReconnect = computed(() => {
  return props.connector.enabled
    && (props.connector.runtime.status === 'error' || Boolean(props.connector.runtime.errorCode))
    && !authenticating.value
    && !canLogin.value
})
</script>

<template>
  <article class="mcp-quick-connection" :aria-label="connector.name">
    <div class="mcp-quick-connection__header">
      <strong class="mcp-quick-connection__name">{{ connector.name }}</strong>
      <NTag v-if="showStatusTag" size="small" :bordered="false" :type="connector.runtime.errorCode ? 'warning' : 'default'">
        {{ t(`desktop.mcp.status.${connector.runtime.status}`) }}
      </NTag>
      <NTooltip>
        <template #trigger>
          <NSwitch :round="false" :value="connector.enabled" :disabled="busy" :aria-label="`${t('desktop.mcp.enabled')}: ${connector.name}`" @update:value="emit('toggle', $event)" />
        </template>
        {{ t(connector.enabled ? 'desktop.mcp.disableHint' : 'desktop.mcp.enableHint') }}
      </NTooltip>
    </div>
    <div class="mcp-quick-connection__details">
      <NButton
        v-if="connector.runtime.toolCount"
        size="tiny"
        quaternary
        class="mcp-quick-connection__tools-btn"
        :disabled="busy"
        @click="emit('tools')"
      >
        {{ t(cachedTools ? 'desktop.mcp.cachedToolsCount' : 'desktop.mcp.toolsCount', { count: connector.runtime.toolCount }) }}
        <span class="mcp-quick-connection__tools-arrow">↗</span>
      </NButton>
      <span v-else class="mcp-quick-connection__no-tools">{{ t(connector.runtime.updatedAt === null ? 'desktop.mcp.noCatalog' : 'desktop.mcp.toolsCount', { count: 0 }) }}</span>
      <span class="mcp-quick-connection__separator">·</span>
      <span class="mcp-quick-connection__exposure">{{ t(`desktop.mcp.exposure.${connector.toolExposure}`) }}</span>
      <div class="mcp-quick-connection__actions">
        <NButton v-if="authenticating" size="tiny" quaternary :disabled="busy" @click="emit('cancelLogin')">
          {{ t('desktop.mcp.cancelLogin') }}
        </NButton>
        <NButton v-else-if="connector.enabled && canLogin" size="tiny" type="primary" :disabled="busy" @click="emit('login')">
          {{ t('desktop.mcp.login') }}
        </NButton>
        <NButton v-else-if="canReconnect" size="tiny" quaternary :disabled="busy || connector.runtime.status === 'connecting'" @click="emit('reconnect')">
          {{ t('desktop.mcp.reconnect') }}
        </NButton>
      </div>
    </div>
    <p v-if="connector.runtime.errorCode" class="mcp-quick-connection__notice">
      {{ t(`desktop.mcp.error.${connector.runtime.errorCode}`) }}
    </p>
    <NButton v-if="connector.enabled && connector.toolExposure === 'codemode' && !codemodeEnabled" class="mcp-quick-connection__notice" size="tiny" text :disabled="busy" @click="emit('runtime')">
      {{ t('desktop.mcp.codemodeRequired') }}
    </NButton>
  </article>
</template>

<style scoped>
.mcp-quick-connection { min-width: 0; padding: 0.75rem 0; border-bottom: 1px solid var(--buddy-border-subtle); }
.mcp-quick-connection:last-child { border-bottom: 0; }
.mcp-quick-connection__header { display: flex; align-items: center; gap: 0.6rem; }
.mcp-quick-connection__name { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 0.9rem; font-weight: 600; }
.mcp-quick-connection__details { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin-top: 0.35rem; color: var(--buddy-text-secondary); font-size: 0.78rem; }
.mcp-quick-connection__tools-btn { padding: 0 4px; height: 20px; font-size: 0.78rem; }
.mcp-quick-connection__tools-arrow { margin-left: 2px; font-size: 0.7rem; opacity: 0.7; }
.mcp-quick-connection__no-tools, .mcp-quick-connection__exposure { font-size: 0.78rem; }
.mcp-quick-connection__separator { color: var(--buddy-text-secondary); opacity: 0.6; }
.mcp-quick-connection__actions { margin-left: auto; }
.mcp-quick-connection__notice { margin: 0.4rem 0 0; color: var(--buddy-status-warning-text); font-size: 0.78rem; white-space: normal; }
</style>
