import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import { randomUUID } from 'node:crypto'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import {
  credentialMutationResultSchema,
  credentialProviderListResultSchema,
  credentialReadResultSchema,
} from '../../../shared/runtime/credentialProtocol'

import { credentialSchema } from './providerSchemas'

export class HostCredentialStoreError extends Error {
  readonly code: string

  constructor(code: string) {
    super('Lexora Buddy credential storage failed')
    this.name = 'HostCredentialStoreError'
    this.code = code
  }
}

export interface CredentialObservation {
  readonly revision: number
  readonly providerId: string
  readonly presence: 'present' | 'absent' | 'unknown'
  readonly type: 'api_key' | 'oauth' | null
}
export type CredentialChange = { readonly kind: 'observation', readonly previous: CredentialObservation | null, readonly current: CredentialObservation }
  | { readonly kind: 'write-confirmed' | 'delete-confirmed', readonly operationId: string, readonly providerId: string }
  | { readonly kind: 'store-availability', readonly revision: number, readonly status: 'known' | 'unknown' }

export class HostCredentialStore implements CredentialStore {
  readonly #pending = new Set<Promise<unknown>>()
  #stopping = false
  readonly #peer: RuntimeRpcPeerContract
  readonly #providerLocks = new Map<string, Promise<void>>()
  readonly #observations = new Map<string, CredentialObservation>()
  readonly #observedRequests = new Map<string, number>()
  readonly #changes = new Emitter<CredentialChange>(() => console.error('CREDENTIAL_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #request = 0
  #availability: 'known' | 'unknown' = 'unknown'
  #availabilityRequest = 0

  get snapshot() {
    return copyEventSnapshot({ revision: this.#revision, availability: this.#availability, providers: [...this.#observations.values()] })
  }

  constructor(peer: RuntimeRpcPeerContract) {
    this.#peer = peer
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#operate(() => this.#read(providerId, options))
  }

  async #read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted()
    const request = ++this.#request
    try {
      const response = credentialReadResultSchema.parse(await this.#peer.request('host.credentials.read', { providerId }))
      assertSuccess(response)
      const value = response.value === null ? undefined : credentialSchema.parse(response.value) as Credential
      this.#observe(providerId, value?.type ?? null, request)
      options?.signal?.throwIfAborted()
      return value
    }
    catch (error) {
      if (!options?.signal?.aborted)
        this.#observe(providerId, 'unknown', request)
      throw error
    }
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.#operate(() => this.#list(options))
  }

  async #list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted()
    const request = ++this.#request
    try {
      const response = credentialProviderListResultSchema.parse(await this.#peer.request('host.credentials.list', {}))
      assertSuccess(response)
      const providers = new Map(response.providers.map(provider => [provider.providerId, provider.type]))
      for (const providerId of new Set([...providers.keys(), ...this.#observations.keys()]))
        this.#observe(providerId, providers.get(providerId) ?? null, request)
      this.#observeAvailability('known', request)
      options?.signal?.throwIfAborted()
      return copyEventSnapshot(response.providers)
    }
    catch (error) {
      if (!options?.signal?.aborted)
        this.#observeAvailability('unknown', request)
      throw error
    }
  }

  modify(
    providerId: string,
    operation: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#withProviderLock(providerId, async () => {
      options?.signal?.throwIfAborted()
      const current = await this.#read(providerId, options)
      const next = await operation(structuredClone(current))
      options?.signal?.throwIfAborted()
      if (next === undefined)
        return current

      const credential = credentialSchema.parse(next) as Credential
      const request = ++this.#request
      try {
        const response = credentialMutationResultSchema.parse(await this.#peer.request('host.credentials.write', { providerId, credential }))
        assertSuccess(response)
      }
      catch (error) {
        this.#observe(providerId, 'unknown', request)
        throw error
      }
      this.#observe(providerId, credential.type, request)
      this.#changes.fire(Object.freeze({ kind: 'write-confirmed', providerId, operationId: randomUUID() }))
      return credential
    })
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#withProviderLock(providerId, async () => {
      options?.signal?.throwIfAborted()
      const request = ++this.#request
      try {
        const response = credentialMutationResultSchema.parse(await this.#peer.request('host.credentials.delete', { providerId }))
        assertSuccess(response)
      }
      catch (error) {
        this.#observe(providerId, 'unknown', request)
        throw error
      }
      this.#observe(providerId, null, request)
      this.#changes.fire(Object.freeze({ kind: 'delete-confirmed', providerId, operationId: randomUUID() }))
    })
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    while (this.#pending.size)
      await Promise.allSettled([...this.#pending])
    this.#changes.dispose()
  }

  #operate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#stopping)
      return Promise.reject(new HostCredentialStoreError('CREDENTIAL_STORE_UNAVAILABLE'))
    const pending = Promise.withResolvers<T>()
    this.#pending.add(pending.promise)
    try {
      void operation().then(pending.resolve, pending.reject)
    }
    catch (error) { pending.reject(error) }
    void pending.promise.then(() => this.#pending.delete(pending.promise), () => this.#pending.delete(pending.promise))
    return pending.promise
  }

  #observe(providerId: string, type: 'api_key' | 'oauth' | 'unknown' | null, request: number): void {
    if (request < (this.#observedRequests.get(providerId) ?? 0))
      return
    this.#observedRequests.set(providerId, request)
    const previous = this.#observations.get(providerId) ?? null
    const presence = type === 'unknown' ? 'unknown' : type ? 'present' : 'absent'
    const credentialType = type === 'unknown' ? null : type
    if (previous?.presence === presence && previous.type === credentialType)
      return
    const current: CredentialObservation = Object.freeze({ revision: ++this.#revision, providerId, presence, type: credentialType })
    this.#observations.set(providerId, current)
    this.#changes.fire(Object.freeze({ kind: 'observation', previous, current }))
  }

  #observeAvailability(status: 'known' | 'unknown', request: number): void {
    if (request < this.#availabilityRequest)
      return
    this.#availabilityRequest = request
    if (this.#availability === status)
      return
    this.#availability = status
    this.#changes.fire(Object.freeze({ kind: 'store-availability', revision: ++this.#revision, status }))
  }

  #withProviderLock<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#stopping)
      return Promise.reject(new HostCredentialStoreError('CREDENTIAL_STORE_UNAVAILABLE'))
    const previous = this.#providerLocks.get(providerId) ?? Promise.resolve()
    const result = this.#operate(() => previous.catch(() => {}).then(operation))
    const tail = result.then(() => {}, () => {})
    this.#providerLocks.set(providerId, tail)
    void tail.then(() => {
      if (this.#providerLocks.get(providerId) === tail)
        this.#providerLocks.delete(providerId)
    })
    return result
  }
}

function assertSuccess<T extends { error?: { code: string }, ok: boolean }>(
  response: T,
): asserts response is T & { ok: true } {
  if (!response.ok)
    throw new HostCredentialStoreError(response.error?.code ?? 'CREDENTIAL_STORE_FAILURE')
}
