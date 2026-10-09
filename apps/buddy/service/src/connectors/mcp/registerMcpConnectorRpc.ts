import type { ConnectorRuntimeState } from '../../../../shared/connectors/connectorState'
import type { RuntimeRequestRegistrar } from '../../rpc/runtimeRequest'
import type { McpServerRecord } from '../../storage/connectorRepository'
import type { McpConnectorService } from './McpConnectorService'
import { connectorsRpc } from '../../../../shared/connectors/connectorApi'
import { ok, registerRuntimeRequest } from '../../rpc/runtimeRequest'

export function registerMcpConnectorRpc(
  rpc: RuntimeRequestRegistrar,
  service: McpConnectorService,
): () => void {
  const disposers: Array<() => void> = []

  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.list, () => {
    return service.list().map(record => toPublicConnector(record, service.state(record.id)))
  }))
  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.upsert, async (input) => {
    await service.save({
      config: { ...input.config, credentialRef: null },
      credential: input.credential,
    })
    return service.list().map(record => toPublicConnector(record, service.state(record.id)))
  }))
  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.remove, async (input) => {
    await service.remove(input.connectorId)
    return ok()
  }))
  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.confirmExecution, async (input) => {
    await service.confirmExecution(input.connectorId)
    return ok()
  }))
  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.saveCredential, async (input) => {
    await service.saveCredential(input.connectorId, input.credential)
    return ok()
  }))
  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.clearCredential, async (input) => {
    await service.clearCredential(input.connectorId)
    return ok()
  }))

  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.setEnabled, async (input) => {
    await service.setEnabled(input.connectorId, input.enabled)
    return ok()
  }))
  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.test, input => service.test(input.connectorId)))
  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.tools, input => service.tools(input.connectorId)))
  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.login, (input) => {
    service.login(input.connectorId)
    return ok()
  }))
  disposers.push(registerRuntimeRequest(rpc, connectorsRpc.cancelLogin, (input) => {
    service.cancelLogin(input.connectorId)
    return ok()
  }))

  return () => disposers.splice(0).forEach(dispose => dispose())
}

function toPublicConnector(record: McpServerRecord, runtime: ConnectorRuntimeState) {
  const common = {
    runtime,
    credentialConfigured: record.credentialRef !== null,
    enabled: record.enabled,
    id: record.id,
    name: record.name,
    toolNamespace: record.toolNamespace,
    toolExposure: record.toolExposure,
    executionConfirmed: record.transport === 'stdio' && record.executionConfirmedAt !== null,
  }
  if (record.transport === 'stdio') {
    return {
      ...common,
      args: record.args ?? [],
      command: record.command ?? '',
      cwd: record.cwd,
      transport: record.transport,
    }
  }
  return { ...common, transport: record.transport, url: record.url ?? '' }
}
