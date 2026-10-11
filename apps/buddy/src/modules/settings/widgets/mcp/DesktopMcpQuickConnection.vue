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
  <article class="mcp-quick-connection min-w-0 py-3 px-0 border-b-1 border-b-solid border-b-border last:border-b-0" :aria-label="connector.name">
    <div class="flex items-center gap-[0.6rem]">
      <strong class="flex-1 min-w-0 [overflow-wrap:anywhere] text-[0.9rem] font-600">{{ connector.name }}</strong>
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
    <div class="flex flex-wrap items-center gap-[0.35rem] mt-[0.35rem] text-muted text-[0.78rem]">
      <NButton
        v-if="connector.runtime.toolCount"
        size="tiny"
        quaternary
        class="mcp-quick-connection__tools-btn"
        :disabled="busy"
        @click="emit('tools')"
      >
        {{ t(cachedTools ? 'desktop.mcp.cachedToolsCount' : 'desktop.mcp.toolsCount', { count: connector.runtime.toolCount }) }}
        <span class="ml-[2px] text-[0.7rem] opacity-70">↗</span>
      </NButton>
      <span v-else class="mcp-quick-connection__no-tools">{{ t(connector.runtime.updatedAt === null ? 'desktop.mcp.noCatalog' : 'desktop.mcp.toolsCount', { count: 0 }) }}</span>
      <span class="text-muted opacity-60">·</span>
      <span class="mcp-quick-connection__exposure">{{ t(`desktop.mcp.exposure.${connector.toolExposure}`) }}</span>
      <div class="ml-auto">
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

<style scoped lang="scss">
.mcp-quick-connection__tools-btn { padding: 0 4px; height: 20px; font-size: 0.78rem; }

.mcp-quick-connection__no-tools, .mcp-quick-connection__exposure { font-size: 0.78rem; }

.mcp-quick-connection__notice { margin: 0.4rem 0 0; color: var(--buddy-status-warning-text); font-size: 0.78rem; white-space: normal; }
</style>
