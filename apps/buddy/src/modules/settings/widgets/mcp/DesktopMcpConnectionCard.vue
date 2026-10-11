<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NPopconfirm, NSwitch, NTag, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { maskConnectorUrl } from '../../model/desktopConnectorTarget'

const props = defineProps<{ connector: LocalConnector, language: BuddyLocale, busy: boolean, codemodeEnabled: boolean }>()
const emit = defineEmits<{ toggle: [enabled: boolean], edit: [], test: [], tools: [], remove: [], login: [], cancelLogin: [], clearCredential: [] }>()
const { t } = useBuddyI18n(() => props.language)
const target = computed(() => props.connector.transport === 'stdio'
  ? [props.connector.command, ...props.connector.args].map(value => JSON.stringify(value)).join(' ')
  : maskConnectorUrl(props.connector.url))
const authenticating = computed(() => props.connector.runtime.status === 'authenticating')
const canLogin = computed(() => props.connector.runtime.authorization === 'oauth'
  && ['MCP_AUTHENTICATION_REQUIRED', 'MCP_AUTHENTICATION_FAILED', 'MCP_AUTHENTICATION_CANCELLED', 'MCP_ACCESS_DENIED'].includes(props.connector.runtime.errorCode ?? ''))
const cachedTools = computed(() => props.connector.runtime.updatedAt !== null && props.connector.runtime.status !== 'ready')
</script>

<template>
  <article class="mcp-connection border-1 border-solid border-border rounded-3 py-[1.1rem] px-[1.2rem] min-w-0" :aria-label="connector.name">
    <header>
      <div class="mcp-connection__identity">
        <h2>{{ connector.name }}</h2>
        <NTag size="small" :bordered="false" :type="connector.runtime.status === 'ready' ? 'success' : connector.runtime.errorCode ? 'warning' : 'default'">
          {{ t(`desktop.mcp.status.${connector.runtime.status}`) }}
        </NTag>
      </div>
      <NTooltip>
        <template #trigger>
          <NSwitch :round="false" :value="connector.enabled" :disabled="busy" :aria-label="`${t('desktop.mcp.enabled')}: ${connector.name}`" @update:value="emit('toggle', $event)" />
        </template>
        {{ t(connector.enabled ? 'desktop.mcp.disableHint' : 'desktop.mcp.enableHint') }}
      </NTooltip>
    </header>
    <p class="font-mono overflow-hidden text-ellipsis whitespace-nowrap mt-[0.85rem] mr-0 mb-[0.35rem] ml-0 text-[0.8rem] text-muted" :title="target">
      {{ target }}
    </p>
    <p class="flex gap-[0.4rem] m-0 text-[0.78rem] text-muted">
      {{ t(connector.transport === 'stdio' ? 'desktop.mcp.stdio' : 'desktop.mcp.http') }}
      <span>·</span> {{ connector.runtime.updatedAt === null ? t('desktop.mcp.noCatalog') : t(cachedTools ? 'desktop.mcp.cachedToolsCount' : 'desktop.mcp.toolsCount', { count: connector.runtime.toolCount }) }}
      <span>·</span> {{ t(`desktop.mcp.exposure.${connector.toolExposure}`) }}
      <span v-if="connector.credentialConfigured">· {{ t('desktop.mcp.configured') }}</span>
    </p>
    <p v-if="connector.runtime.errorCode" class="text-warning text-[0.82rem] mt-[0.65rem] mr-0 mb-0 ml-0">
      {{ t(`desktop.mcp.error.${connector.runtime.errorCode}`) }}
    </p>
    <p v-if="connector.enabled && connector.toolExposure === 'codemode' && !codemodeEnabled" class="text-warning text-[0.82rem] mt-[0.65rem] mr-0 mb-0 ml-0">
      {{ t('desktop.mcp.codemodeDisabled') }}
    </p>
    <footer>
      <div>
        <NButton size="small" :disabled="busy || authenticating" @click="emit('test')">
          {{ t('desktop.mcp.test') }}
        </NButton>
        <NButton size="small" quaternary :disabled="busy || !connector.runtime.toolCount" @click="emit('tools')">
          {{ t(cachedTools ? 'desktop.mcp.cachedTools' : 'desktop.mcp.tools') }}
        </NButton>
        <NButton v-if="authenticating" size="small" quaternary :disabled="busy" @click="emit('cancelLogin')">
          {{ t('desktop.mcp.cancelLogin') }}
        </NButton>
        <NButton v-else-if="canLogin" size="small" type="primary" :disabled="busy" @click="emit('login')">
          {{ t('desktop.mcp.login') }}
        </NButton>
      </div>
      <div>
        <NButton size="small" quaternary :disabled="busy" @click="emit('edit')">
          {{ t('desktop.mcp.edit') }}
        </NButton>
        <NPopconfirm v-if="connector.credentialConfigured" @positive-click="emit('clearCredential')">
          <template #trigger>
            <NButton size="small" quaternary :disabled="busy">
              {{ t('desktop.mcp.clearCredential') }}
            </NButton>
          </template>
          {{ t('desktop.mcp.clearConfirm') }}
        </NPopconfirm>
        <NPopconfirm @positive-click="emit('remove')">
          <template #trigger>
            <NButton size="small" quaternary :disabled="busy">
              {{ t('desktop.mcp.remove') }}
            </NButton>
          </template>
          {{ t('desktop.mcp.removeConfirm') }}
        </NPopconfirm>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.mcp-connection header, .mcp-connection__identity { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
.mcp-connection header { justify-content: space-between; }
.mcp-connection h2 { margin: 0; font-size: 0.95rem; font-weight: 600; overflow-wrap: anywhere; }
.mcp-connection footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem; border-top: 1px solid var(--buddy-border-subtle); margin-top: 1rem; padding-top: 0.65rem; }
.mcp-connection footer > div { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
</style>
