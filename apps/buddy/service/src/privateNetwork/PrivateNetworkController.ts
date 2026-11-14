import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import type { RuntimePlatform } from '../platform/RuntimePlatform'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { AuthenticatedDevice } from './DeviceAuthorizationService'
import type { PrivateNetworkServerOptions } from './PrivateNetworkServer'
import { privateNetworkManagement, privateNetworkStatusSchema } from '../../../shared/privateNetwork/management'
import { PrivateNetworkError } from '../../../shared/privateNetwork/pairing'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'
import { withTransaction } from '../storage/transaction'
import { DeviceAuthorizationService } from './DeviceAuthorizationService'
import { selectPrivateNetworkAddress } from './privateNetworkAddress'
import { PrivateNetworkServer } from './PrivateNetworkServer'
import { isPrivateNetworkAddress, loadPrivateNetworkTlsIdentity } from './PrivateNetworkTlsIdentity'

interface PrivateNetworkControllerOptions {
  database: DatabaseSync
  serviceId: string
  profileId: string
  serviceInstanceId: string
  secrets: RuntimePlatform['privateNetworkSecrets']
  connect: PrivateNetworkServerOptions['connect']
  bytes?: PrivateNetworkServerOptions['bytes']
}
export class PrivateNetworkController {
  readonly auth: DeviceAuthorizationService
  readonly #options: PrivateNetworkControllerOptions
  #server: PrivateNetworkServer | null = null
  #endpoint: string | null = null
  #error: z.infer<typeof privateNetworkStatusSchema>['errorCode'] = null
  #pending = Promise.resolve()
  #closed = false

  constructor(options: PrivateNetworkControllerOptions) {
    this.#options = options
    this.auth = new DeviceAuthorizationService(options)
  }

  status() {
    const stored = this.#options.database.prepare('SELECT * FROM private_network_state WHERE id = 1').get()!
    const enabled = stored.enabled === 1
    return privateNetworkStatusSchema.parse({ enabled, state: this.#server ? 'listening' : enabled ? 'unavailable' : 'disabled', bindAddress: stored.bind_address, port: stored.port, endpoint: this.#endpoint, spkiPin: stored.tls_pin, errorCode: this.#error })
  }

  async restore(): Promise<void> {
    await this.#serialize(async () => {
      if (this.status().enabled)
        await this.#listen()
    })
  }

  configure(input: z.infer<typeof privateNetworkManagement.configure.input>) {
    return this.#serialize(async () => {
      const previous = this.status()
      const configuredAddress = input.bindAddress === '' ? null : input.bindAddress ?? previous.bindAddress
      const address = configuredAddress ?? (input.enabled ? selectPrivateNetworkAddress() : null)
      const port = input.port ?? previous.port ?? 19443
      if (address !== null && !isPrivateNetworkAddress(address))
        throw new PrivateNetworkError('INVALID_REQUEST')
      withTransaction(this.#options.database, () => this.#options.database.prepare('UPDATE private_network_state SET enabled = ?, bind_address = ?, port = ? WHERE id = 1').run(Number(input.enabled), address, port))
      this.auth.cancelTicket()
      await this.#stopListener()
      if (input.enabled)
        await this.#listen()
      return this.status()
    })
  }

  resetIdentity() {
    return this.#serialize(async () => {
      this.auth.revokeAll()
      await this.#stopListener()
      if (this.status().enabled) {
        await this.#listen(true)
      }
      else {
        const { database, profileId, secrets } = this.#options
        if (!secrets)
          throw new PrivateNetworkError('TLS_IDENTITY_UNAVAILABLE')
        await loadPrivateNetworkTlsIdentity({ database, profileId, secrets, addresses: [this.status().bindAddress ?? '127.0.0.1'], reset: true })
      }
      return this.status()
    })
  }

  register(rpc: RuntimeRequestRegistrar): void {
    registerRuntimeRequest(rpc, privateNetworkManagement.status, () => this.status())
    registerRuntimeRequest(rpc, privateNetworkManagement.configure, input => this.configure(input))
    registerRuntimeRequest(rpc, privateNetworkManagement.issuePairing, () => {
      const status = this.status()
      if (!status.endpoint || !status.spkiPin)
        throw new PrivateNetworkError('PAIRING_UNAVAILABLE')
      return this.auth.issue(status.endpoint, status.spkiPin)
    })
    registerRuntimeRequest(rpc, privateNetworkManagement.cancelPairing, (input) => {
      this.auth.cancelTicket(input.ticketId)
      return { ok: true as const }
    })
    registerRuntimeRequest(rpc, privateNetworkManagement.devices, () => this.auth.list())
    registerRuntimeRequest(rpc, privateNetworkManagement.revoke, (input) => {
      this.auth.revoke(input.deviceId)
      return { ok: true as const }
    })
    registerRuntimeRequest(rpc, privateNetworkManagement.resetIdentity, () => this.resetIdentity())
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.#pending.catch(() => {})
    await this.#stopListener()
  }

  async #listen(reset = false) {
    const { database, profileId, serviceId, secrets, connect, bytes } = this.#options
    const status = this.status()
    if (!secrets) {
      this.#error = 'CREDENTIAL_STORE_UNAVAILABLE'
      return
    }
    if (!status.bindAddress) {
      this.#error = 'ADDRESS_UNAVAILABLE'
      return
    }
    let server: PrivateNetworkServer | null = null
    try {
      const tls = await loadPrivateNetworkTlsIdentity({ database, profileId, secrets, addresses: [status.bindAddress!], reset })
      server = new PrivateNetworkServer({ tls, auth: this.auth, identity: { serviceId, profileId }, connect, bytes })
      this.#endpoint = await server.listen(status.bindAddress!, status.port!)
      this.#server = server
      this.#error = null
    }
    catch (error) {
      await server?.close()
      const code = (error as { code?: string }).code
      this.#error = code === 'EADDRINUSE' ? 'ADDRESS_IN_USE' : code === 'EADDRNOTAVAIL' ? 'ADDRESS_UNAVAILABLE' : code?.startsWith('CREDENTIAL_') ? 'CREDENTIAL_STORE_UNAVAILABLE' : code === 'TLS_IDENTITY_UNAVAILABLE' ? 'TLS_IDENTITY_UNAVAILABLE' : 'LISTEN_FAILED'
    }
  }

  async #stopListener() {
    const server = this.#server
    this.#server = null
    this.#endpoint = null
    this.#error = null
    await server?.close()
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed)
      return Promise.reject(new PrivateNetworkError('PAIRING_UNAVAILABLE'))
    const result = this.#pending.catch(() => {}).then(operation)
    this.#pending = result.then(() => {}, () => {})
    return result
  }
}

export type PrivateNetworkConnectionFactory = (identity: AuthenticatedDevice, transport: Parameters<PrivateNetworkServerOptions['connect']>[1]) => ReturnType<PrivateNetworkServerOptions['connect']>
