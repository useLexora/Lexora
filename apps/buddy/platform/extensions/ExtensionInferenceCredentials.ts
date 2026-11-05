import type { InferenceCredential, InferenceCredentialReference } from '../../shared/extensions/extensionInference'
import { z } from 'zod'
import { inferenceCredentialSchema } from '../../shared/extensions/extensionInference'

interface CredentialStore {
  read: (id: string) => Promise<unknown | null>
  write: (id: string, value: unknown) => Promise<void>
  delete: (id: string) => Promise<void>
}
const credentialsSchema = z.array(inferenceCredentialSchema).max(32)

export class ExtensionInferenceCredentials {
  readonly #pending = new Map<string, Promise<unknown>>()
  readonly store: CredentialStore
  constructor(store: CredentialStore) { this.store = store }

  async #read(extensionId: string) {
    return credentialsSchema.parse(await this.store.read(extensionId) ?? [])
  }

  async has(extensionId: string, reference: InferenceCredentialReference): Promise<boolean> {
    return (await this.#read(extensionId)).some(item => item.id === reference.id && item.origin === reference.origin)
  }

  async authorize(extensionId: string, reference: InferenceCredentialReference): Promise<string> {
    const credential = (await this.#read(extensionId)).find(item => item.id === reference.id && item.origin === reference.origin)
    if (!credential)
      throw new Error('EXTENSION_INFERENCE_CREDENTIAL_UNAVAILABLE')
    return `Bearer ${credential.token}`
  }

  set(extensionId: string, input: InferenceCredential, assertCurrent: () => void): Promise<void> {
    const credential = inferenceCredentialSchema.parse(input)
    return this.#mutate(extensionId, async () => {
      const next = (await this.#read(extensionId)).filter(item => item.id !== credential.id)
      next.push(credential)
      credentialsSchema.parse(next)
      assertCurrent()
      await this.store.write(extensionId, next)
    })
  }

  remove(extensionId: string, id: string, assertCurrent: () => void): Promise<void> {
    return this.#mutate(extensionId, async () => {
      const next = (await this.#read(extensionId)).filter(item => item.id !== id)
      assertCurrent()
      if (next.length)
        await this.store.write(extensionId, next)
      else
        await this.store.delete(extensionId)
    })
  }

  clear(extensionId: string): Promise<void> {
    return this.#mutate(extensionId, () => this.store.delete(extensionId))
  }

  #mutate(extensionId: string, operation: () => Promise<void>): Promise<void> {
    const pending = (this.#pending.get(extensionId) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.#pending.set(extensionId, pending)
    return pending.finally(() => {
      if (this.#pending.get(extensionId) === pending)
        this.#pending.delete(extensionId)
    })
  }
}
