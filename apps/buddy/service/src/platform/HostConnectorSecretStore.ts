import type { ConnectorCredential } from '../../../shared/connectors/connectorCredentials'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ConnectorSecretStore } from '../connectors/mcp/McpConnectorService'
import { connectorCredentialSchema } from '../../../shared/connectors/connectorCredentials'
import { credentialMutationResultSchema, credentialReadResultSchema } from '../../../shared/runtime/credentialProtocol'
import { McpConnectorError } from '../connectors/mcp/McpConnectorService'

export class HostConnectorSecretStore implements ConnectorSecretStore {
  readonly #peer: Pick<RuntimeRpcPeerContract, 'request'>

  constructor(peer: Pick<RuntimeRpcPeerContract, 'request'>) {
    this.#peer = peer
  }

  async read(id: string): Promise<ConnectorCredential | null> {
    const response = credentialReadResultSchema.parse(await this.#peer.request(
      'host.secrets.read',
      { id, namespace: 'connectors' },
    ))
    if (!response.ok)
      throw new McpConnectorError(response.error.code)
    return response.value === null ? null : connectorCredentialSchema.parse(response.value)
  }

  async write(id: string, credential: ConnectorCredential): Promise<void> {
    const response = credentialMutationResultSchema.parse(await this.#peer.request(
      'host.secrets.write',
      { id, namespace: 'connectors', value: connectorCredentialSchema.parse(credential) },
    ))
    if (!response.ok)
      throw new McpConnectorError(response.error.code)
  }

  async delete(id: string): Promise<void> {
    const response = credentialMutationResultSchema.parse(await this.#peer.request(
      'host.secrets.delete',
      { id, namespace: 'connectors' },
    ))
    if (!response.ok)
      throw new McpConnectorError(response.error.code)
  }
}
