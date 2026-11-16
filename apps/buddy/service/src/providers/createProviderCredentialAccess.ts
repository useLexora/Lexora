import type { CredentialStore } from '@earendil-works/pi-ai'
import type { ProviderConfigRepository } from '../storage/providerConfigRepository'

export function createProviderCredentialAccess(credentials: CredentialStore, configs: Pick<ProviderConfigRepository, 'findById'>): CredentialStore {
  function canRead(providerId: string): boolean {
    const config = configs.findById(providerId)
    return !config || (config.authentication !== 'none' && config.credentialRef !== null)
  }

  return {
    read: (providerId, options) => canRead(providerId) ? credentials.read(providerId, options) : Promise.resolve(undefined),
    list: async options => (await credentials.list(options)).filter(credential => canRead(credential.providerId)),
    modify: (providerId, operation, options) => credentials.modify(providerId, current => operation(canRead(providerId) ? current : undefined), options),
    delete: (providerId, options) => credentials.delete(providerId, options),
  }
}
