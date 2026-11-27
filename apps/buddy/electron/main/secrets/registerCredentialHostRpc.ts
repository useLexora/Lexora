import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { createCredentialVault } from './CredentialVault'
import { shell } from 'electron'
import {
  credentialMutationResultSchema,
  credentialProviderListResultSchema,
  credentialReadParamsSchema,
  credentialReadResultSchema,
  credentialWriteParamsSchema,
  openExternalParamsSchema,
  openExternalResultSchema,
  providerCredentialParamsSchema,
  providerCredentialWriteParamsSchema,
} from '../../../shared/runtime/credentialProtocol'

import { CredentialStoreUnavailableError } from './CredentialVault'

export interface RegisterCredentialHostRpcOptions {
  openExternal?: (url: string) => Promise<unknown>
}

export function registerCredentialHostRpc(
  peer: RuntimeRpcPeerContract,
  vault: ReturnType<typeof createCredentialVault>,
  options: RegisterCredentialHostRpcOptions = {},
): () => void {
  const openExternal = options.openExternal ?? (url => shell.openExternal(url))
  const disposers = [
    peer.onRequest('host.credentials.read', async (params) => {
      const parsed = providerCredentialParamsSchema.safeParse(params)
      if (!parsed.success)
        return credentialReadResultSchema.parse(validationFailure())
      return runHostOperation(
        () => vault.read('providers', parsed.data.providerId),
        value => credentialReadResultSchema.parse({ ok: true, value }),
      )
    }),
    peer.onRequest('host.credentials.list', async () => runHostOperation(
      () => vault.scanProviders(),
      inventory => credentialProviderListResultSchema.parse({ ok: true, ...inventory }),
    )),
    peer.onRequest('host.credentials.write', async (params) => {
      const parsed = providerCredentialWriteParamsSchema.safeParse(params)
      if (!parsed.success)
        return credentialMutationResultSchema.parse(validationFailure())
      return runHostOperation(
        () => vault.write('providers', parsed.data.providerId, parsed.data.credential),
        () => credentialMutationResultSchema.parse({ ok: true }),
      )
    }),
    peer.onRequest('host.credentials.delete', async (params) => {
      const parsed = providerCredentialParamsSchema.safeParse(params)
      if (!parsed.success)
        return credentialMutationResultSchema.parse(validationFailure())
      return runHostOperation(
        () => vault.delete('providers', parsed.data.providerId),
        () => credentialMutationResultSchema.parse({ ok: true }),
      )
    }),
    peer.onRequest('host.secrets.read', async (params) => {
      const parsed = credentialReadParamsSchema.safeParse(params)
      if (!parsed.success)
        return credentialReadResultSchema.parse(validationFailure())
      return runHostOperation(
        () => vault.read(parsed.data.namespace, parsed.data.id),
        value => credentialReadResultSchema.parse({ ok: true, value }),
      )
    }),
    peer.onRequest('host.secrets.write', async (params) => {
      const parsed = credentialWriteParamsSchema.safeParse(params)
      if (!parsed.success)
        return credentialMutationResultSchema.parse(validationFailure())
      return runHostOperation(
        () => vault.write(parsed.data.namespace, parsed.data.id, parsed.data.value),
        () => credentialMutationResultSchema.parse({ ok: true }),
      )
    }),
    peer.onRequest('host.secrets.delete', async (params) => {
      const parsed = credentialReadParamsSchema.safeParse(params)
      if (!parsed.success)
        return credentialMutationResultSchema.parse(validationFailure())
      return runHostOperation(
        () => vault.delete(parsed.data.namespace, parsed.data.id),
        () => credentialMutationResultSchema.parse({ ok: true }),
      )
    }),
    peer.onRequest('host.openExternal', async (params) => {
      const parsed = openExternalParamsSchema.safeParse(params)
      if (!parsed.success || !isAllowedExternalUrl(parsed.data.url))
        return openExternalResultSchema.parse(externalUrlFailure())
      await openExternal(parsed.data.url)
      return openExternalResultSchema.parse({ ok: true })
    }),
  ]
  return () => disposers.forEach(dispose => dispose())
}

export function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:')
      return true
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
  }
  catch {
    return false
  }
}

async function runHostOperation<T, R>(
  operation: () => Promise<T>,
  success: (value: T) => R,
): Promise<R | ReturnType<typeof credentialFailure>> {
  try {
    return success(await operation())
  }
  catch (error) {
    return credentialFailure(error)
  }
}

function credentialFailure(error: unknown): {
  error: { code: 'CREDENTIAL_STORE_FAILURE' | 'CREDENTIAL_STORE_UNAVAILABLE' }
  ok: false
} {
  return {
    error: {
      code: error instanceof CredentialStoreUnavailableError
        ? 'CREDENTIAL_STORE_UNAVAILABLE'
        : 'CREDENTIAL_STORE_FAILURE',
    },
    ok: false,
  }
}

function validationFailure(): { error: { code: 'VALIDATION_FAILED' }, ok: false } {
  return { error: { code: 'VALIDATION_FAILED' }, ok: false }
}

function externalUrlFailure(): { error: { code: 'EXTERNAL_URL_NOT_ALLOWED' }, ok: false } {
  return { error: { code: 'EXTERNAL_URL_NOT_ALLOWED' }, ok: false }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
