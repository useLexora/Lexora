<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NPopconfirm, NSwitch, NTag, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { maskConnectorUrl } from '../../model/desktopConnectorTarget'

const props = defineProps<{ connector: LocalConnector, language: BuddyLocale, busy: boolean }>()
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
  <article class="mcp-connection" :aria-label="connector.name">
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
    <p class="mcp-connection__target" :title="target">
      {{ target }}
    </p>
    <p class="mcp-connection__meta">
      {{ t(connector.transport === 'stdio' ? 'desktop.mcp.stdio' : 'desktop.mcp.http') }}
      <span>·</span> {{ connector.runtime.updatedAt === null ? t('desktop.mcp.noCatalog') : t(cachedTools ? 'desktop.mcp.cachedToolsCount' : 'desktop.mcp.toolsCount', { count: connector.runtime.toolCount }) }}
      <span v-if="connector.credentialConfigured">· {{ t('desktop.mcp.configured') }}</span>
    </p>
    <p v-if="connector.runtime.errorCode" class="mcp-connection__error">
      {{ t(`desktop.mcp.error.${connector.runtime.errorCode}`) }}
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

<style scoped>
.mcp-connection { border: 1px solid var(--buddy-border-subtle); border-radius: 0.75rem; padding: 1.1rem 1.2rem; min-width: 0; }
.mcp-connection header, .mcp-connection__identity { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
.mcp-connection header { justify-content: space-between; }
.mcp-connection h2 { margin: 0; font-size: 0.95rem; font-weight: 600; overflow-wrap: anywhere; }
.mcp-connection__target { font-family: var(--buddy-font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0.85rem 0 0.35rem; font-size: 0.8rem; color: var(--buddy-text-secondary); }
.mcp-connection__meta { display: flex; gap: 0.4rem; margin: 0; font-size: 0.78rem; color: var(--buddy-text-secondary); }
.mcp-connection__error { color: var(--buddy-status-warning-text); font-size: 0.82rem; margin: 0.65rem 0 0; }
.mcp-connection footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem; border-top: 1px solid var(--buddy-border-subtle); margin-top: 1rem; padding-top: 0.65rem; }
.mcp-connection footer > div { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
</style>
