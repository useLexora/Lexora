import type { AuthType, CredentialInfo } from '@earendil-works/pi-ai'
import { createHash } from 'node:crypto'
import { ProviderAuthenticationRequiredError, ProviderUnavailableError } from './ProviderFailure'

interface CredentialInventory {
  providers: readonly CredentialInfo[]
  unreadableProviderDigests: readonly string[]
}

export interface ProviderCredentialSource {
  list: () => Promise<readonly CredentialInfo[]>
  scan?: () => Promise<CredentialInventory>
}

type CredentialState = AuthType | 'unknown' | null
type Lookup = (providerId: string) => CredentialState

export function createCredentialLookup(inventory: CredentialInventory): Lookup {
  const providers = new Map(inventory.providers.map(item => [item.providerId, item.type]))
  const unreadable = new Set(inventory.unreadableProviderDigests)
  return id => providers.get(id) ?? (unreadable.size && unreadable.has(createHash('sha256').update(id).digest('hex')) ? 'unknown' : null)
}

const unknown: Lookup = () => 'unknown'

export function isCredentialStoreFailure(error: unknown): boolean {
  return error instanceof Error && 'code' in error
    && (error.code === 'CREDENTIAL_STORE_UNAVAILABLE' || error.code === 'CREDENTIAL_STORE_FAILURE')
}

export interface ProviderCredentialStatus {
  type: (providerId: string) => AuthType | null
  refresh: () => Promise<{ storeKnown: boolean, lookup: Lookup }>
  requireType: (providerId: string) => Promise<AuthType>
}

export function createProviderCredentialStatus(source: ProviderCredentialSource): ProviderCredentialStatus {
  let current: Lookup = unknown
  let sequence = 0
  let accepted = 0
  const refresh = async (strict: boolean) => {
    const request = ++sequence
    let lookup = unknown
    try {
      lookup = createCredentialLookup(source.scan ? await source.scan() : { providers: await source.list(), unreadableProviderDigests: [] })
    }
    catch (error) {
      if (strict || !isCredentialStoreFailure(error))
        throw error
    }
    finally {
      if (request >= accepted) {
        accepted = request
        current = lookup
      }
    }
    return { storeKnown: lookup !== unknown, lookup }
  }
  return {
    type(providerId) {
      const type = current(providerId)
      return type === 'unknown' ? null : type
    },
    refresh: () => refresh(false),
    async requireType(providerId) {
      const type = (await refresh(true)).lookup(providerId)
      if (type === 'unknown')
        throw new ProviderUnavailableError()
      if (!type)
        throw new ProviderAuthenticationRequiredError()
      return type
    },
  }
}
