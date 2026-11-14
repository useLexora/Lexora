import type { RuntimeRpcPeerContract } from '../../../apps/buddy/shared/runtime/rpcPeer'
import { openBuddyMigrationCandidate } from '../../../apps/buddy/service/src/storage/database'
import { extensionAgentRpc } from '../../../apps/buddy/shared/extensions/extensionAgent'
import { extensionCapabilitiesRpc } from '../../../apps/buddy/shared/extensions/extensionCapabilities'
import { extensionChatRpc } from '../../../apps/buddy/shared/extensions/extensionChat'
import { extensionImageRpc } from '../../../apps/buddy/shared/extensions/extensionImage'
import { extensionImageReadingRpc } from '../../../apps/buddy/shared/extensions/extensionImageReading'
import { extensionShellRpc } from '../../../apps/buddy/shared/extensions/extensionShell'
import { extensionSkillsRpc } from '../../../apps/buddy/shared/extensions/extensionSkills'
import { imageRpc } from '../../../apps/buddy/shared/images/imagePreferences'
import { DEFAULT_NETWORK_PERMISSIONS } from '../../../apps/buddy/shared/permissions/networkPermissions'
import { networkPermissionsRpc } from '../../../apps/buddy/shared/permissions/networkPermissionsRpc'
import { HOST_SPEECH_MODELS } from '../../../apps/buddy/shared/speech/speechApi'

export { RuntimeRpcPeer } from '../../../apps/buddy/platform/ipc/runtimeRpcPeer'
export { createBuddyServiceEnvironment } from '../../../apps/buddy/platform/process/serviceEnvironment'
export { DEFAULT_RUNTIME_PREFERENCES } from '../../../apps/buddy/shared/runtime/runtimePreferences'
export { BUDDY_SERVICE_PROTOCOL_VERSION } from '../../../apps/buddy/shared/runtime/runtimeProtocol'

export function registerFixtureHost(peer: RuntimeRpcPeerContract, options: { secrets?: Map<string, unknown>, persistSecrets?: () => Promise<void> } = {}): void {
  const credentials = new Map<string, unknown>([['process-fixture', { type: 'api_key', key: 'process-fixture-key' }]])
  peer.onRequest('host.credentials.list', () => ({ ok: true, providers: [...credentials.keys()].map(providerId => ({ providerId, type: 'api_key' })) }))
  peer.onRequest('host.credentials.read', raw => ({ ok: true, value: credentials.get((raw as { providerId: string }).providerId) ?? null }))
  peer.onRequest('host.credentials.write', (raw) => {
    const { providerId, credential } = raw as { providerId: string, credential: unknown }
    credentials.set(providerId, credential)
    return { ok: true }
  })
  peer.onRequest('host.credentials.delete', (raw) => {
    credentials.delete((raw as { providerId: string }).providerId)
    return { ok: true }
  })
  const secrets = options.secrets ?? new Map<string, unknown>()
  peer.onRequest('host.secrets.read', (raw) => {
    const { namespace, id } = raw as { namespace: string, id: string }
    return { ok: true, value: secrets.get(`${namespace}:${id}`) ?? null }
  })
  peer.onRequest('host.secrets.write', async (raw) => {
    const { namespace, id, value } = raw as { namespace: string, id: string, value: unknown }
    secrets.set(`${namespace}:${id}`, value)
    await options.persistSecrets?.()
    return { ok: true }
  })
  peer.onRequest('host.secrets.delete', async (raw) => {
    const { namespace, id } = raw as { namespace: string, id: string }
    secrets.delete(`${namespace}:${id}`)
    await options.persistSecrets?.()
    return { ok: true }
  })
  for (const method of [extensionAgentRpc.list, extensionCapabilitiesRpc.list, extensionChatRpc.list, extensionImageRpc.list, extensionImageReadingRpc.list, extensionShellRpc.list, extensionSkillsRpc.list, HOST_SPEECH_MODELS])
    peer.onRequest(method, () => [])
  peer.onRequest(imageRpc.preferences, () => ({}))
  peer.onRequest(networkPermissionsRpc.get, () => structuredClone(DEFAULT_NETWORK_PERMISSIONS))
}

export function createCandidateFixtureDatabase(path: string): void {
  const database = openBuddyMigrationCandidate({ databasePath: path })
  try {
    database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  }
  finally { database.close() }
}
