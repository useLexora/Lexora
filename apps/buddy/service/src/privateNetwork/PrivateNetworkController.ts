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
import { selectPrivateNetworkAddresses } from './privateNetworkAddress'
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
  #addresses: string[] = []
  readonly #preferredAddress: string | null
  #bindAddress: string | null = null
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #error: z.infer<typeof privateNetworkStatusSchema>['errorCode'] = null
  #pending = Promise.resolve()
  #closed = false

  constructor(options: PrivateNetworkControllerOptions) {
    this.#options = options
    this.#preferredAddress = options.database.prepare('SELECT bind_address FROM private_network_state WHERE id = 1').get()!.bind_address as string | null
    this.auth = new DeviceAuthorizationService(options)
  }

  status() {
    const stored = this.#options.database.prepare('SELECT * FROM private_network_state WHERE id = 1').get()!
    const enabled = stored.enabled === 1
    const endpoint = this.#endpoints()[0] ?? null
    return privateNetworkStatusSchema.parse({ enabled, state: endpoint ? 'listening' : enabled ? 'unavailable' : 'disabled', bindAddress: this.#bindAddress, port: stored.port, endpoint, spkiPin: stored.tls_pin, errorCode: this.#error })
  }

  async restore(): Promise<void> {
    await this.#serialize(async () => {
      const status = this.status()
      if (status.enabled)
        await this.#listen(status)
    })
  }

  configure(input: z.infer<typeof privateNetworkManagement.configure.input>) {
    return this.#serialize(async () => {
      const previous = this.status()
      const address = input.bindAddress === '' ? null : input.bindAddress ?? previous.bindAddress
      const port = input.port ?? previous.port ?? 19443
      if (address !== null && !isPrivateNetworkAddress(address))
        throw new PrivateNetworkError('INVALID_REQUEST')
      withTransaction(this.#options.database, () => this.#options.database.prepare('UPDATE private_network_state SET enabled = ?, port = ? WHERE id = 1').run(Number(input.enabled), port))
      this.#bindAddress = address
      this.auth.cancelTicket()
      if (!input.enabled || port !== previous.port)
        await this.#stopListener()
      if (input.enabled)
        await this.#listen(this.status())
      return this.status()
    })
  }

  resetIdentity() {
    return this.#serialize(async () => {
      this.auth.revokeAll()
      await this.#stopListener()
      if (this.status().enabled) {
        await this.#listen(this.status(), true)
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
      return this.auth.issue(status.endpoint, status.spkiPin, this.#endpoints()[1])
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

  #endpoints(): string[] {
    return this.#addresses.map(address => this.#server?.endpoint(address)).filter((endpoint): endpoint is string => !!endpoint)
  }

  async #listen(status: ReturnType<PrivateNetworkController['status']>, reset = false) {
    const { database, profileId, serviceId, secrets, connect, bytes } = this.#options
    if (!secrets) {
      this.#error = 'CREDENTIAL_STORE_UNAVAILABLE'
      return
    }
    clearTimeout(this.#refreshTimer)
    if (!status.bindAddress && !this.#closed) {
      this.#refreshTimer = setTimeout(() => {
        void this.#serialize(async () => {
          const current = this.status()
          if (current.enabled && !current.bindAddress)
            await this.#listen(current)
        }).catch(() => {})
      }, 5000).unref()
    }
    const addresses = status.bindAddress ? [status.bindAddress] : selectPrivateNetworkAddresses(undefined, this.#preferredAddress)
    try {
      const removed = this.#addresses.filter(address => !addresses.includes(address))
      this.#addresses = addresses
      await Promise.all(removed.map(address => this.#server?.unlisten(address)))
      if (!addresses.length) {
        this.#error = 'ADDRESS_UNAVAILABLE'
        if (reset)
          await loadPrivateNetworkTlsIdentity({ database, profileId, secrets, addresses: ['127.0.0.1'], reset })
        return
      }
      const missing = addresses.filter(address => !this.#server?.endpoint(address))
      if (!missing.length) {
        this.#error = null
        return
      }
      const tls = await loadPrivateNetworkTlsIdentity({ database, profileId, secrets, addresses, reset })
      this.#server ??= new PrivateNetworkServer({ tls, auth: this.auth, identity: { serviceId, profileId }, connect, bytes, endpoints: () => this.#endpoints() })
      this.#server.updateTls(tls)
      const results = await Promise.allSettled(missing.map(address => this.#server!.listen(address, status.port ?? 19443)))
      this.#error = this.#endpoints().length ? null : listenerError(results.find(result => result.status === 'rejected')?.reason)
    }
    catch (error) {
      this.#error = listenerError(error)
    }
  }

  async #stopListener() {
    clearTimeout(this.#refreshTimer)
    const server = this.#server
    this.#server = null
    this.#addresses = []
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

function listenerError(error: unknown): NonNullable<ReturnType<PrivateNetworkController['status']>['errorCode']> {
  const code = (error as { code?: string } | undefined)?.code
  if (code === 'EADDRINUSE')
    return 'ADDRESS_IN_USE'
  if (code === 'EADDRNOTAVAIL')
    return 'ADDRESS_UNAVAILABLE'
  if (code?.startsWith('CREDENTIAL_'))
    return 'CREDENTIAL_STORE_UNAVAILABLE'
  return code === 'TLS_IDENTITY_UNAVAILABLE' ? code : 'LISTEN_FAILED'
}
