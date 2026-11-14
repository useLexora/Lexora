import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { RuntimePlatform, RuntimePreferenceSource } from './RuntimePlatform'
import { z } from 'zod'
import { automationNotifications } from '../../../shared/automation/automationApi'
import { contextPanelRpc, contextPanelStateSchema } from '../../../shared/context-panel/contextPanel'
import { extensionAgentCatalogSchema, extensionAgentDescriptorSchema, extensionAgentRequestSchema, extensionAgentRpc } from '../../../shared/extensions/extensionAgent'
import { extensionJsonSchema } from '../../../shared/extensions/extensionApi'
import { EXTENSION_CAPABILITIES_RPC, EXTENSION_IDENTITY_RPC, EXTENSION_INSPECT_RPC, EXTENSION_PACKAGE_TRANSFER_RPC, EXTENSION_REVIEW_REQUEST, extensionCapabilitiesSchema, extensionIdentitySchema, extensionInspectionSchema } from '../../../shared/extensions/extensionAuthoring'
import { extensionCapabilitiesRpc, extensionCapabilityApplyRpc, extensionCapabilityDescriptorSchema, extensionCapabilityImpactRpc } from '../../../shared/extensions/extensionCapabilities'
import { extensionIdSchema } from '../../../shared/extensions/extensionManifest'
import { extensionShellRpc } from '../../../shared/extensions/extensionShell'
import { extensionSkillDescriptorSchema, extensionSkillsRpc } from '../../../shared/extensions/extensionSkills'
import { imagePreferencesSchema, imageRpc } from '../../../shared/images/imagePreferences'
import { credentialMutationResultSchema, credentialReadResultSchema, openExternalResultSchema } from '../../../shared/runtime/credentialProtocol'
import { petExecuteSequenceResultSchema } from '../../../shared/runtime/petProtocol'
import { runtimePreferencesRpc, runtimePreferencesSchema } from '../../../shared/runtime/runtimePreferences'
import { desktopOpenResultSchema } from '../../../shared/service/localServiceProtocol'
import { skillReviewRequested } from '../../../shared/skills/skillApi'
import { registerAttachmentRpc } from '../attachments/registerAttachmentRpc'
import { BrowserHostClient } from '../browser/BrowserHostClient'
import { createPluginImageBackends } from '../images/createPluginImageBackends'
import { ImageReadingService } from '../images/ImageReadingService'
import { PluginImageGateway } from '../images/PluginImageGateway'
import { NetworkPermissionsClient } from '../permissions/NetworkPermissionsClient'
import { createExtensionResourceCapabilities } from '../plugins/extensionResourceCapabilities'
import { registerExtensionConditionRpc } from '../plugins/registerExtensionConditionRpc'
import { HostCredentialStore, HostCredentialStoreError } from '../providers/HostCredentialStore'
import { PluginModelRegistry } from '../providers/PluginModelRegistry'
import { refreshProviderSpeechModels, registerProviderSpeechRpc } from '../providers/registerProviderSpeechRpc'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'
import { ShellSandboxClient } from '../sandbox/ShellSandboxClient'
import { ExtensionShellRegistry } from '../sandbox/ShellSelection'
import { WebHostClient } from '../web/WebHostClient'
import { HostConnectorSecretStore } from './HostConnectorSecretStore'

export function createRpcRuntimePlatform(peer: RuntimeRpcPeerContract, options: {
  display?: boolean
  preferences?: RuntimePreferenceSource
} = {}): RuntimePlatform {
  const display = options.display ?? true
  const subscribe = (method: string, changed: () => void) => peer.onNotification((event) => {
    if (event === method)
      changed()
  })
  return {
    openDesktop: async (intent, signal) => desktopOpenResultSchema.parse(await peer.request('host.openDesktop', intent, 25000, signal)),
    privateNetworkSecrets: {
      async read(id) {
        const result = credentialReadResultSchema.parse(await peer.request('host.secrets.read', { namespace: 'private-network', id }))
        if (!result.ok)
          throw new HostCredentialStoreError(result.error.code)
        return result.value
      },
      async write(id, value) {
        const result = credentialMutationResultSchema.parse(await peer.request('host.secrets.write', { namespace: 'private-network', id, value }))
        if (!result.ok)
          throw new HostCredentialStoreError(result.error.code)
      },
    },
    createCredentials: () => new HostCredentialStore(peer),
    connectorSecrets: new HostConnectorSecretStore(peer),
    webSecrets: {
      async read() {
        const result = credentialReadResultSchema.parse(await peer.request('host.secrets.read', { namespace: 'web', id: 'tavily' }))
        if (!result.ok)
          throw new HostCredentialStoreError(result.error.code)
        return typeof result.value === 'string' && result.value ? result.value : null
      },
      async write(key) {
        const result = credentialMutationResultSchema.parse(await peer.request(key === null ? 'host.secrets.delete' : 'host.secrets.write', { namespace: 'web', id: 'tavily', ...(key === null ? {} : { value: key }) }))
        if (!result.ok)
          throw new HostCredentialStoreError(result.error.code)
      },
    },
    browser: new BrowserHostClient(peer),
    createWeb: () => new WebHostClient(peer),
    createSandbox: () => new ShellSandboxClient(peer),
    createPluginImages: () => new PluginImageGateway(peer),
    createPluginImageBackends: (providers, gateway) => createPluginImageBackends(peer, providers, gateway),
    createImageReading: options => new ImageReadingService({ ...options, rpc: peer }),
    createPluginModels: (providers, failed) => new PluginModelRegistry(peer, providers, failed),
    createExtensionResources: (artifacts, task, scope) => createExtensionResourceCapabilities({ rpc: peer, artifacts }, task, scope),
    imagePreferences: async signal => imagePreferencesSchema.parse(await peer.request(imageRpc.preferences, {}, 30000, signal)),
    shells: new ExtensionShellRegistry(peer),
    networkPermissions: new NetworkPermissionsClient(peer),
    skills: {
      list: async () => extensionSkillDescriptorSchema.array().parse(await peer.request(extensionSkillsRpc.list, {})),
      subscribe: changed => subscribe(extensionSkillsRpc.changed, changed),
    },
    capabilities: {
      list: async () => extensionCapabilityDescriptorSchema.array().parse(await peer.request(extensionCapabilitiesRpc.list, {})),
      subscribe: changed => subscribe(extensionCapabilitiesRpc.changed, changed),
      bind(handlers) {
        const impact = registerRuntimeRequest(peer, extensionCapabilityImpactRpc, input => handlers.impact(input.extensionId))
        const apply = registerRuntimeRequest(peer, extensionCapabilityApplyRpc, async (input, signal) => {
          await handlers.apply(input.descriptors, input.clearExtensionId, signal)
          return null
        })
        return () => {
          impact()
          apply()
        }
      },
    },
    subscribeShellChanges: changed => subscribe(extensionShellRpc.changed, changed),
    subscribeSandboxReady: ready => subscribe('host.sandbox.ready', ready),
    reviewSkill(preview) {
      if (!display)
        throw new Error('DESKTOP_UNAVAILABLE')
      peer.notify(skillReviewRequested.method, preview)
    },
    refreshProviderSpeech: options => refreshProviderSpeechModels({ ...options, rpc: peer }),
    plugins: {
      releaseRun: async (runId) => { await peer.request(extensionAgentRpc.releaseRun, { runId }) },
      list: async signal => z.array(extensionAgentDescriptorSchema.extend({ id: extensionIdSchema })).parse(await peer.request(extensionAgentRpc.list, {}, 10000, signal)),
      invoke: async (input, signal) => extensionJsonSchema.parse(await peer.request(extensionAgentRpc.invoke, input, null, signal)),
      subscribe: apply => peer.onNotification((method, params) => {
        if (method === extensionAgentRpc.changed)
          apply(extensionAgentCatalogSchema.parse(params))
      }),
      bindInference(handlers) {
        const acquire = peer.onRequest('extensions.inference.acquire', (raw, signal) => handlers.acquire(z.object({ extensionId: extensionIdSchema, invocationId: z.uuid(), parentInvocationId: z.uuid().optional() }).strict().parse(raw), signal))
        const release = peer.onRequest('extensions.inference.release', raw => handlers.release(z.object({ invocationId: z.uuid() }).strict().parse(raw).invocationId))
        return () => {
          acquire()
          release()
        }
      },
      bind: handler => peer.onRequest(extensionAgentRpc.request, (input, signal) => handler(extensionAgentRequestSchema.parse(input), signal)),
    },
    authoring: {
      transfer: (input, signal) => peer.request(EXTENSION_PACKAGE_TRANSFER_RPC, input, input.action === 'build' ? 45000 : 10000, signal),
      review(path) {
        if (!display)
          throw new Error('DESKTOP_UNAVAILABLE')
        peer.notify(EXTENSION_REVIEW_REQUEST, { path })
      },
      identity: async (input, signal) => extensionIdentitySchema.parse(await peer.request(EXTENSION_IDENTITY_RPC, input, 10000, signal)),
      capabilities: async (input, signal) => extensionCapabilitiesSchema.parse(await peer.request(EXTENSION_CAPABILITIES_RPC, input, 10000, signal)),
      inspect: async (id, signal) => extensionInspectionSchema.parse(await peer.request(EXTENSION_INSPECT_RPC, { id }, 10000, signal)),
    },
    preferences: options.preferences ?? {
      get: async () => runtimePreferencesSchema.parse(await peer.request(runtimePreferencesRpc.get, {})),
      subscribe: apply => peer.onNotification((method, params) => {
        if (method === runtimePreferencesRpc.changed)
          apply(runtimePreferencesSchema.parse(params))
      }),
    },
    async openExternal(url) {
      if (!display)
        throw new Error('DESKTOP_UNAVAILABLE')
      const result = openExternalResultSchema.parse(await peer.request('host.openExternal', { url }))
      if (!result.ok)
        throw new Error('DESKTOP_UNAVAILABLE')
    },
    presentBrowser: display ? async (source) => { contextPanelStateSchema.parse(await peer.request(contextPanelRpc.presentBrowser, source)) } : undefined,
    executePetSequence: async input => display
      ? petExecuteSequenceResultSchema.parse(await peer.request('host.pet.executeSequence', input, 20000))
      : { code: 'PET_UNAVAILABLE', completedSteps: 0, status: 'failed' },
    subscribeWake: wake => peer.onNotification((method, params) => {
      if (method === automationNotifications.wake.method && automationNotifications.wake.params.safeParse(params).success)
        wake()
    }),
    bindInternal(services) {
      const registrations: (() => void)[] = []
      const dispose = () => registrations.splice(0).reverse().forEach(unregister => unregister())
      try {
        registrations.push(registerExtensionConditionRpc({ rpc: peer, ...services.conditions }))
        registrations.push(registerAttachmentRpc({ rpc: peer, service: services.attachments }))
        registrations.push(registerProviderSpeechRpc({ rpc: peer, ...services.speech }))
        return dispose
      }
      catch (error) {
        dispose()
        throw error
      }
    },
  }
}
