import type { ConnectorCredential } from '../../../../shared/connectors/connectorCredentials'
import type { McpConnectorDetails } from './mcpEvents'

export interface ConnectorSecretStore {
  delete: (id: string) => Promise<void>
  read: (id: string) => Promise<ConnectorCredential | null>
  write: (id: string, credential: ConnectorCredential) => Promise<void>
}

interface CredentialChange<T> {
  connectorId: string
  replacement: { ref: string, value: ConnectorCredential | null } | null
  validate?: () => void
  commit: () => T
  committed?: (result: T) => boolean
}

type CredentialEvent = Extract<McpConnectorDetails, { type: 'credential' }>

export class McpCredentialChanges {
  readonly #secrets: ConnectorSecretStore
  readonly #publish: (connectorId: string, event: CredentialEvent) => void

  constructor(secrets: ConnectorSecretStore, publish: (connectorId: string, event: CredentialEvent) => void) {
    this.#secrets = secrets
    this.#publish = publish
  }

  async commit<T>(change: CredentialChange<T>): Promise<T> {
    const { connectorId, replacement } = change
    if (!replacement) {
      change.validate?.()
      return change.commit()
    }
    const previous = await this.#secrets.read(replacement.ref)
    change.validate?.()
    let result: T
    try {
      await this.#write(replacement.ref, replacement.value)
      this.#publish(connectorId, { type: 'credential', status: replacement.value ? 'written' : 'deleted', presence: replacement.value ? 'present' : 'absent' })
      change.validate?.()
      result = change.commit()
    }
    catch (error) {
      await this.#restore(connectorId, replacement.ref, previous)
      throw error
    }
    if (change.committed && !change.committed(result))
      await this.#restore(connectorId, replacement.ref, previous)
    return result
  }

  #write(ref: string, value: ConnectorCredential | null): Promise<void> {
    return value ? this.#secrets.write(ref, value) : this.#secrets.delete(ref)
  }

  async #restore(connectorId: string, ref: string, previous: ConnectorCredential | null): Promise<void> {
    try {
      await this.#write(ref, previous)
      this.#publish(connectorId, { type: 'credential', status: 'restored', presence: previous ? 'present' : 'absent' })
    }
    catch (error) {
      this.#publish(connectorId, { type: 'credential', status: 'restore-failed', presence: 'unknown' })
      throw error
    }
  }
}
