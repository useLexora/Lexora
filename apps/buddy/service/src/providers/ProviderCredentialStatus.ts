import type { CredentialInfo } from '@earendil-works/pi-ai'

export interface ProviderCredentialSource {
  list: () => Promise<readonly CredentialInfo[]>
}

export interface ProviderCredentialStatus {
  readonly availability: 'known' | 'unknown'
  list: () => Promise<readonly CredentialInfo[]>
  listOrEmpty: () => Promise<readonly CredentialInfo[]>
}

export function createProviderCredentialStatus(
  source: ProviderCredentialSource,
): ProviderCredentialStatus {
  let availability: 'known' | 'unknown' = 'unknown'
  let sequence = 0
  let accepted = 0
  const observe = (request: number, status: typeof availability) => {
    if (request >= accepted) {
      accepted = request
      availability = status
    }
  }
  const list = async () => {
    const request = ++sequence
    try {
      const credentials = await source.list()
      observe(request, 'known')
      return credentials
    }
    catch (error) {
      observe(request, 'unknown')
      throw error
    }
  }
  return {
    get availability() { return availability },
    list,
    async listOrEmpty() {
      try {
        return await list()
      }
      catch (error) {
        if (isCredentialStoreUnavailable(error))
          return []
        throw error
      }
    },
  }
}

function isCredentialStoreUnavailable(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'CREDENTIAL_STORE_UNAVAILABLE'
}
