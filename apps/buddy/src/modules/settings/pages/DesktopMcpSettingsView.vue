<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { ConnectorRuntimeState, ConnectorToolSummary } from '@buddy-shared/connectors/connectorState'
import type { DesktopConnectorSavePlan } from '../model/desktopConnectorForm'
import { NAlert, NButton, NEmpty, NModal } from 'naive-ui'
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSettingsPageLayout from '../layouts/DesktopSettingsPageLayout.vue'
import { useSettingsContext } from '../settingsContext'
import DesktopMcpConnectionCard from '../widgets/mcp/DesktopMcpConnectionCard.vue'
import DesktopMcpConnectionEditor from '../widgets/mcp/DesktopMcpConnectionEditor.vue'
import DesktopMcpImportDialog from '../widgets/mcp/DesktopMcpImportDialog.vue'
import DesktopMcpToolsDialog from '../widgets/mcp/DesktopMcpToolsDialog.vue'

const { mcpSettings: mcp, ready } = useSettingsContext()
const { connectors, busyId, error, loaded, language } = mcp
const { t } = useBuddyI18n(language)
const editor = shallowRef<{ connector: LocalConnector | null } | null>(null)
const importing = shallowRef(false)
const toolList = shallowRef<{ id: string, tools: readonly ConnectorToolSummary[] } | null>(null)
const toolConnector = computed(() => connectors.value.find(connector => connector.id === toolList.value?.id))
const executionConfirmation = shallowRef<{ connector: LocalConnector, next: 'test' | 'enable' } | null>(null)
const testResult = shallowRef<{ name: string, enabled: boolean, state: ConnectorRuntimeState } | null>(null)
let mounted = true
let timer: ReturnType<typeof setTimeout> | undefined
onMounted(async () => {
  await ready
  const poll = async () => {
    if (!mounted)
      return
    await mcp.load()
    if (mounted)
      timer = setTimeout(poll, 1500)
  }
  await poll()
})
onUnmounted(() => {
  mounted = false
  clearTimeout(timer)
})
async function save(plan: DesktopConnectorSavePlan) {
  if (await mcp.save(plan)) {
    editor.value = null
    testResult.value = null
  }
}
function login(connector: LocalConnector) {
  testResult.value = null
  return mcp.login(connector.id)
}
async function test(connector: LocalConnector) {
  if (connector.transport === 'stdio' && !connector.executionConfirmed) {
    executionConfirmation.value = { connector, next: 'test' }
    return
  }
  const state = await mcp.test(connector.id)
  if (state)
    testResult.value = { name: connector.name, enabled: connector.enabled, state }
}
async function toggle(connector: LocalConnector, enabled: boolean) {
  testResult.value = null
  if (enabled && connector.transport === 'stdio' && !connector.executionConfirmed)
    executionConfirmation.value = { connector, next: 'enable' }
  else
    await mcp.setEnabled(connector.id, enabled)
}
async function confirmExecution() {
  const pending = executionConfirmation.value
  if (!pending || !await mcp.confirmExecution(pending.connector.id))
    return
  executionConfirmation.value = null
  if (pending.next === 'enable')
    await mcp.setEnabled(pending.connector.id, true)
  else if (pending.next === 'test')
    await test({ ...pending.connector, executionConfirmed: true })
}
async function showTools(connector: LocalConnector) {
  const tools = await mcp.tools(connector.id)
  if (tools)
    toolList.value = { id: connector.id, tools }
}
function formatStdioTarget(connector: LocalConnector): string {
  if (connector.transport !== 'stdio')
    return ''
  return JSON.stringify({
    command: connector.command,
    args: connector.args,
    ...(connector.cwd ? { cwd: connector.cwd } : {}),
  }, null, 2)
}
</script>

<template>
  <DesktopSettingsPageLayout requires-runtime :loading="!loaded">
    <template #title>
      {{ t('desktop.settings.category.mcp') }}
    </template>
    <template #description>
      {{ t('desktop.settings.categoryDescription.mcp') }}
    </template>
    <template #actions>
      <div class="mcp-settings__actions">
        <NButton size="small" :disabled="!!busyId" @click="importing = true">
          {{ t('desktop.mcp.import') }}
        </NButton>
        <NButton size="small" type="primary" :disabled="!!busyId" @click="editor = { connector: null }">
          {{ t('desktop.mcp.add') }}
        </NButton>
      </div>
    </template>
    <section class="mcp-settings">
      <NAlert v-if="error" type="error" :show-icon="false">
        {{ error }}
      </NAlert>
      <NAlert v-if="testResult" :type="testResult.state.status === 'ready' ? 'success' : 'warning'" :show-icon="false" closable @close="testResult = null">
        {{ testResult.name }} · {{ testResult.state.errorCode ? t(`desktop.mcp.error.${testResult.state.errorCode}`) : t(testResult.enabled ? 'desktop.mcp.testPassed' : 'desktop.mcp.testPassedDisabled') }}
      </NAlert>
      <NEmpty v-if="loaded && !connectors.length" :description="t('desktop.mcp.empty')" class="mcp-settings__empty">
        <template #extra>
          <p>{{ t('desktop.mcp.emptyDescription') }}</p>
        </template>
      </NEmpty>
      <DesktopMcpConnectionCard
        v-for="connector in connectors" :key="connector.id" :connector="connector" :language="language" :busy="!!busyId"
        @toggle="toggle(connector, $event)" @edit="editor = { connector }" @test="test(connector)" @tools="showTools(connector)"
        @remove="mcp.remove(connector.id)" @login="login(connector)" @cancel-login="mcp.cancelLogin(connector.id)" @clear-credential="mcp.clearCredential(connector.id)"
      />
    </section>
    <DesktopMcpConnectionEditor v-if="editor" :connector="editor.connector" :language="language" :busy="!!busyId" :error="error" @close="editor = null" @save="save" />
    <DesktopMcpImportDialog v-if="importing" :language="language" :save="mcp.save" :error="error" @close="importing = false" />
    <NModal
      v-if="executionConfirmation"
      show
      preset="dialog"
      type="warning"
      :title="t('desktop.mcp.confirmExecutionTitle')"
      :closable="!busyId"
      :mask-closable="!busyId"
      @close="executionConfirmation = null"
      @update:show="value => !value && (executionConfirmation = null)"
    >
      <p>{{ t('desktop.mcp.confirmExecutionDescription') }}</p>
      <pre class="mcp-settings__target">{{ formatStdioTarget(executionConfirmation.connector) }}</pre>
      <template #action>
        <NButton :disabled="!!busyId" @click="executionConfirmation = null">
          {{ t('common.cancel') }}
        </NButton>
        <NButton type="primary" :loading="!!busyId" @click="confirmExecution">
          {{ t('desktop.mcp.confirmExecution') }}
        </NButton>
      </template>
    </NModal>
    <DesktopMcpToolsDialog v-if="toolList && toolConnector" :connector="toolConnector" :tools="toolList.tools" :language="language" @close="toolList = null" />
  </DesktopSettingsPageLayout>
</template>

<style scoped>
.mcp-settings__actions { display: flex; gap: 0.5rem; }
.mcp-settings { display: grid; gap: 1rem; }
.mcp-settings__empty { padding: 4rem 1rem; }
.mcp-settings__empty p { color: var(--buddy-text-secondary); font-size: 0.85rem; }
.mcp-settings__target { overflow-wrap: anywhere; white-space: pre-wrap; padding: 0.8rem; background: var(--buddy-surface-subtle); border-radius: 0.5rem; }
</style>
