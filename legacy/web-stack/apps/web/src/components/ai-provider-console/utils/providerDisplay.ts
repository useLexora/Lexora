import type { AiProviderRow, CompatibleProviderKey } from '../typing'
import { COMPATIBLE_PROVIDER_KEYS } from '../typing'

export function isCompatibleProviderKey(providerKey: string): providerKey is CompatibleProviderKey {
  return COMPATIBLE_PROVIDER_KEYS.includes(providerKey as CompatibleProviderKey)
}

export function isValidProviderEndpointUrl(value: string) {
  try {
    void new URL(value)
    return true
  }
  catch {
    return false
  }
}

export function getProviderInitial(row: AiProviderRow) {
  return row.title.trim().slice(0, 1).toUpperCase() || 'AI'
}

export function getProviderStatusType(row: AiProviderRow) {
  return row.provider.enabled ? 'success' : 'info'
}
