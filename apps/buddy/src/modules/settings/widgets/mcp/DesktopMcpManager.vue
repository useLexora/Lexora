<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { ConnectorToolSummary } from '@buddy-shared/connectors/connectorState'
import type { DesktopConnectorSavePlan } from '../../model/desktopConnectorForm'
import type { McpSettingsCapability } from '../../state/useMcpSettingsCapability'
import { ChevronDown16Regular } from '@vicons/fluent'
import { NAlert, NButton, NDropdown, NEmpty } from 'naive-ui'
import { computed, onMounted, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useMcpConnectionActions } from '../../state/useMcpConnectionActions'
import DesktopMcpConnectionCard from './DesktopMcpConnectionCard.vue'
import DesktopMcpConnectionEditor from './DesktopMcpConnectionEditor.vue'
import DesktopMcpExecutionDialog from './DesktopMcpExecutionDialog.vue'
import DesktopMcpImportDialog from './DesktopMcpImportDialog.vue'
import DesktopMcpToolsDialog from './DesktopMcpToolsDialog.vue'

const { mcp, ready, codemodeEnabled } = defineProps<{ mcp: McpSettingsCapability, ready?: Promise<void>, codemodeEnabled: boolean }>()
const { connectors, busyId, error, loaded, language } = mcp
const { t } = useBuddyI18n(language)
const editor = shallowRef<{ connector: LocalConnector | null, initialTransport?: 'stdio' | 'streamable-http' } | null>(null)
const importing = shallowRef(false)
const addMenuOpen = shallowRef(false)
const toolList = shallowRef<{ id: string, tools: readonly ConnectorToolSummary[] } | null>(null)
const toolConnector = computed(() => connectors.value.find(connector => connector.id === toolList.value?.id))
const { executionConfirmation, testResult, clearTestResult, cancelExecution, confirmExecution, test, toggle } = useMcpConnectionActions(mcp)

const addOptions = computed(() => [
  { key: 'stdio', label: t('desktop.mcp.addStdio') },
  { key: 'streamable-http', label: t('desktop.mcp.addHttp') },
])

function handleAddSelect(key: 'stdio' | 'streamable-http') {
  editor.value = { connector: null, initialTransport: key }
}
onMounted(async () => {
  await ready
  await mcp.load()
})
async function save(plan: DesktopConnectorSavePlan) {
  if (await mcp.save(plan)) {
    editor.value = null
    clearTestResult()
  }
}
function login(connector: LocalConnector) {
  clearTestResult()
  return mcp.login(connector.id)
}
async function showTools(connector: LocalConnector) {
  const tools = await mcp.tools(connector.id)
  if (tools)
    toolList.value = { id: connector.id, tools }
}
</script>

<template>
  <div class="mcp-manager">
    <div class="mcp-settings__actions">
      <div class="mcp-settings__split-actions">
        <NButton size="small" type="primary" :disabled="!!busyId" @click="importing = true">
          {{ t('desktop.mcp.import') }}
        </NButton>
        <NDropdown
          v-model:show="addMenuOpen"
          trigger="click"
          placement="bottom-end"
          :options="addOptions"
          :disabled="!!busyId"
          @select="handleAddSelect"
        >
          <NButton
            class="mcp-settings__split-arrow"
            type="primary"
            size="small"
            :disabled="!!busyId"
            :aria-label="t('desktop.mcp.add')"
            aria-haspopup="menu"
            :aria-expanded="addMenuOpen"
          >
            <template #icon>
              <DesktopIcon
                :component="ChevronDown16Regular"
                :size="14"
                class="mcp-settings__split-chevron"
                :class="{ 'is-open': addMenuOpen }"
              />
            </template>
          </NButton>
        </NDropdown>
      </div>
    </div>
    <section class="mcp-settings" :aria-busy="!loaded">
      <NAlert v-if="error" type="error" :show-icon="false">
        {{ error }}
      </NAlert>
      <NAlert v-if="testResult" :type="testResult.state.status === 'ready' ? 'success' : 'warning'" :show-icon="false" closable @close="clearTestResult">
        {{ testResult.name }} · {{ testResult.state.errorCode ? t(`desktop.mcp.error.${testResult.state.errorCode}`) : t(testResult.enabled ? 'desktop.mcp.testPassed' : 'desktop.mcp.testPassedDisabled') }}
      </NAlert>
      <NEmpty v-if="loaded && !connectors.length" :description="t('desktop.mcp.empty')" class="mcp-settings__empty">
        <template #extra>
          <p>{{ t('desktop.mcp.emptyDescription') }}</p>
        </template>
      </NEmpty>
      <DesktopMcpConnectionCard
        v-for="connector in connectors" :key="connector.id" :connector="connector" :language="language" :busy="!!busyId" :codemode-enabled="codemodeEnabled"
        @toggle="toggle(connector, $event)" @edit="editor = { connector }" @test="test(connector)" @tools="showTools(connector)"
        @remove="mcp.remove(connector.id)" @login="login(connector)" @cancel-login="mcp.cancelLogin(connector.id)" @clear-credential="mcp.clearCredential(connector.id)"
      />
    </section>
    <DesktopMcpConnectionEditor v-if="editor" :connector="editor.connector" :initial-transport="editor.initialTransport" :language="language" :busy="!!busyId" :error="error" :codemode-enabled="codemodeEnabled" @close="editor = null" @save="save" />
    <DesktopMcpImportDialog v-if="importing" :language="language" :save="mcp.save" :error="error" @close="importing = false" />
    <DesktopMcpExecutionDialog v-if="executionConfirmation" :connector="executionConfirmation.connector" :language="language" :busy="!!busyId" @close="cancelExecution" @confirm="confirmExecution" />
    <DesktopMcpToolsDialog v-if="toolList && toolConnector" :connector="toolConnector" :tools="toolList.tools" :language="language" @close="toolList = null" />
  </div>
</template>

<style scoped>
.mcp-settings__actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-bottom: 1rem; }
.mcp-settings__split-actions { display: inline-flex; align-items: stretch; }
.mcp-settings__split-actions > :deep(.n-button:first-child) { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.mcp-settings__split-arrow { width: 28px; margin-left: 1px; padding: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
.mcp-settings__split-chevron { transition: transform 140ms ease; }
.mcp-settings__split-chevron.is-open { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) { .mcp-settings__split-chevron { transition: none; } }
.mcp-settings { display: grid; gap: 1rem; }
.mcp-settings__empty { padding: 4rem 1rem; }
.mcp-settings__empty p { color: var(--buddy-text-secondary); font-size: 0.85rem; }
</style>
