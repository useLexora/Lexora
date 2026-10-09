<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { ConnectorToolSummary } from '@buddy-shared/connectors/connectorState'
import { NAlert, NButton, NEmpty, NModal, NScrollbar, NSpin, useMessage } from 'naive-ui'
import { computed, onMounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useSettingsContext } from '../../settingsContext'
import { useMcpConnectionActions } from '../../state/useMcpConnectionActions'
import DesktopMcpExecutionDialog from './DesktopMcpExecutionDialog.vue'
import DesktopMcpQuickConnection from './DesktopMcpQuickConnection.vue'
import DesktopMcpToolsDialog from './DesktopMcpToolsDialog.vue'

const emit = defineEmits<{ close: [] }>()
const { applicationSettings, mcpSettings: mcp, ready } = useSettingsContext()
const { language } = applicationSettings
const { t } = useBuddyI18n(language)
const message = useMessage()
const router = useRouter()
const { busyId, error, loaded } = mcp
const actions = useMcpConnectionActions(mcp)
const { executionConfirmation } = actions
const toolList = shallowRef<{ id: string, tools: readonly ConnectorToolSummary[] } | null>(null)
const toolConnector = computed(() => mcp.connectors.value.find(connector => connector.id === toolList.value?.id))
const connectors = computed(() => [...mcp.connectors.value].sort((a, b) => Number(b.enabled && !!b.runtime.errorCode) - Number(a.enabled && !!a.runtime.errorCode) || Number(b.enabled) - Number(a.enabled)))
const codemodeEnabled = computed(() => applicationSettings.config.value?.runtime.codemode ?? false)

onMounted(async () => {
  await ready
  await mcp.load()
})

async function perform(action: () => Promise<unknown>) {
  const result = await action()
  if (result === null && error.value)
    message.error(error.value)
}

function toggle(connector: LocalConnector, enabled: boolean) {
  return perform(() => actions.toggle(connector, enabled))
}

async function showTools(connector: LocalConnector) {
  const tools = await mcp.tools(connector.id)
  if (tools)
    toolList.value = { id: connector.id, tools }
  else if (error.value)
    message.error(error.value)
}

async function openSettings(category: 'mcp' | 'runtime') {
  await router.push(desktopRouteLocations.settings(category))
  emit('close')
}
</script>

<template>
  <NModal
    show
    preset="card"
    class="mcp-quick-panel"
    :style="{ width: 'min(440px, calc(100vw - 48px))' }"
    :mask-closable="!busyId"
    :closable="!busyId"
    @close="emit('close')"
    @update:show="value => !value && emit('close')"
  >
    <template #header>
      <div class="mcp-quick-panel__header">
        <span class="mcp-quick-panel__title">{{ t('desktop.settings.category.mcp') }}</span>
        <NButton text size="tiny" class="mcp-quick-panel__manage-btn" :disabled="!!busyId" @click="openSettings('mcp')">
          {{ t('desktop.mcp.manageConnections') }}
        </NButton>
      </div>
    </template>
    <NAlert v-if="!loaded && error" type="error" :show-icon="false">
      {{ error }}
      <NButton text @click="mcp.load()">
        {{ t('desktop.loading.retry') }}
      </NButton>
    </NAlert>
    <NSpin v-else-if="!loaded" size="small" class="mcp-quick-panel__loading" />
    <NScrollbar v-else style="max-height: min(420px, 55vh)">
      <NEmpty v-if="!connectors.length" :description="t('desktop.mcp.empty')" class="mcp-quick-panel__empty" />
      <DesktopMcpQuickConnection
        v-for="connector in connectors" :key="connector.id" :connector="connector" :language="language" :busy="!!busyId" :codemode-enabled="codemodeEnabled"
        @toggle="toggle(connector, $event)" @tools="showTools(connector)" @reconnect="perform(() => actions.test(connector))"
        @login="perform(() => mcp.login(connector.id))" @cancel-login="perform(() => mcp.cancelLogin(connector.id))" @runtime="openSettings('runtime')"
      />
    </NScrollbar>
  </NModal>
  <DesktopMcpExecutionDialog v-if="executionConfirmation" :connector="executionConfirmation.connector" :language="language" :busy="!!busyId" @close="actions.cancelExecution" @confirm="perform(actions.confirmExecution)" />
  <DesktopMcpToolsDialog v-if="toolList && toolConnector" :connector="toolConnector" :tools="toolList.tools" :language="language" @close="toolList = null" />
</template>

<style scoped>
.mcp-quick-panel__header { display: flex; align-items: center; gap: 0.75rem; }
.mcp-quick-panel__title { font-weight: 600; font-size: 0.95rem; }
.mcp-quick-panel__manage-btn { color: var(--buddy-text-secondary); font-size: 0.78rem; transition: color 0.15s ease; }
.mcp-quick-panel__manage-btn:hover { color: var(--buddy-text-primary); }
.mcp-quick-panel__loading, .mcp-quick-panel__empty { display: flex; justify-content: center; padding: 2rem 0; }
</style>
