import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { ConnectorRuntimeState } from '@buddy-shared/connectors/connectorState'
import type { McpSettingsCapability } from './useMcpSettingsCapability'
import { shallowReadonly, shallowRef } from 'vue'

export function useMcpConnectionActions(mcp: McpSettingsCapability) {
  const executionConfirmation = shallowRef<{ connector: LocalConnector, next: 'test' | 'enable' } | null>(null)
  const testResult = shallowRef<{ name: string, enabled: boolean, state: ConnectorRuntimeState } | null>(null)

  function clearTestResult() {
    testResult.value = null
  }

  function cancelExecution() {
    executionConfirmation.value = null
  }

  async function test(connector: LocalConnector) {
    if (connector.transport === 'stdio' && !connector.executionConfirmed) {
      executionConfirmation.value = { connector, next: 'test' }
      return
    }
    const state = await mcp.test(connector.id)
    if (state)
      testResult.value = { name: connector.name, enabled: connector.enabled, state }
    return state
  }

  async function toggle(connector: LocalConnector, enabled: boolean) {
    clearTestResult()
    if (enabled && connector.transport === 'stdio' && !connector.executionConfirmed) {
      executionConfirmation.value = { connector, next: 'enable' }
      return
    }
    return mcp.setEnabled(connector.id, enabled)
  }

  async function confirmExecution() {
    const pending = executionConfirmation.value
    if (!pending)
      return
    if (!await mcp.confirmExecution(pending.connector.id))
      return null
    cancelExecution()
    return pending.next === 'enable'
      ? mcp.setEnabled(pending.connector.id, true)
      : test({ ...pending.connector, executionConfirmed: true })
  }

  return { executionConfirmation: shallowReadonly(executionConfirmation), testResult: shallowReadonly(testResult), clearTestResult, cancelExecution, test, toggle, confirmExecution }
}
