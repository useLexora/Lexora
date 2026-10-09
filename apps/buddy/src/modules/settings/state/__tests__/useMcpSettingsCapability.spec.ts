import type { ConnectorChangeNotice, LocalConnector } from '@buddy-shared/connectors/connectorApi'
import { describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useMcpSettingsCapability } from '../useMcpSettingsCapability'

const notice: ConnectorChangeNotice = { sourceId: '00000000-0000-4000-8000-000000000001', revision: 1, generation: 1, connectorId: 'fixture', type: 'runtime' }
const connector: LocalConnector = { id: 'fixture', name: 'Fixture', toolNamespace: 'fixture', toolExposure: 'deferred', enabled: false, credentialConfigured: false, executionConfirmed: false, transport: 'streamable-http', url: 'https://example.test/mcp', runtime: { status: 'disabled', authorization: null, errorCode: null, toolCount: 0, updatedAt: null } }

describe('mcpSettingsCapability', () => {
  it('reconciles a notice arriving during the initial snapshot and ignores late results after scope disposal', async () => {
    const listeners = new Set<(event: ConnectorChangeNotice) => void>()
    const first = Promise.withResolvers<readonly LocalConnector[]>()
    const next = [{ ...connector, enabled: true }]
    let read = () => first.promise
    const mutate = async () => ({ ok: true as const })
    const scope = effectScope()
    const capability = scope.run(() => useMcpSettingsCapability({ language: shallowRef('zh-CN'), api: {
      list: () => read(),
      onChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      setEnabled: mutate,
      test: async () => connector.runtime,
      tools: async () => [],
      login: mutate,
      cancelLogin: mutate,
      upsert: async () => [],
      remove: mutate,
      confirmExecution: mutate,
      setCredential: mutate,
      clearCredential: mutate,
    } }))!
    const loading = capability.load()
    read = async () => next
    for (const listener of listeners)
      listener(notice)
    first.resolve([connector])
    await loading
    expect(capability.connectors.value[0]?.enabled).toBe(true)
    const late = Promise.withResolvers<readonly LocalConnector[]>()
    read = () => late.promise
    const pending = capability.load()
    scope.stop()
    late.resolve([connector])
    await pending
    expect(capability.connectors.value[0]?.enabled).toBe(true)
    expect(listeners.size).toBe(0)
  })
})
