import type { ContextPanelSource } from '../../../shared/context-panel/contextPanel'
import type { ExtensionCapabilityDescriptor, ExtensionCapabilityImpact } from '../../../shared/extensions/extensionCapabilities'
import type { ExtensionSkillDescriptor } from '../../../shared/extensions/extensionSkills'
import type { ImagePreferences } from '../../../shared/images/imagePreferences'
import type { PetExecuteSequenceParams, PetExecuteSequenceResult } from '../../../shared/runtime/petProtocol'
import type { RuntimePreferences } from '../../../shared/runtime/runtimePreferences'
import type { DesktopOpenIntent, DesktopOpenResult } from '../../../shared/service/localServiceProtocol'
import type { SkillInstallPreview } from '../../../shared/skills/skillApi'
import type { registerAttachmentRpc } from '../attachments/registerAttachmentRpc'
import type { BrowserCapabilityHost } from '../browser/BrowserCapabilityService'
import type { ConnectorSecretStore } from '../connectors/mcp/McpConnectorService'
import type { createPluginImageBackends } from '../images/createPluginImageBackends'
import type { ImageReadingService } from '../images/ImageReadingService'
import type { PluginImageGateway } from '../images/PluginImageGateway'
import type { NetworkPermissionsStore } from '../permissions/NetworkPermissionsClient'
import type { createExtensionResourceCapabilities } from '../plugins/extensionResourceCapabilities'
import type { PluginAgentHost, PluginAuthoringHost } from '../plugins/PluginHost'
import type { registerExtensionConditionRpc } from '../plugins/registerExtensionConditionRpc'
import type { HostCredentialStore } from '../providers/HostCredentialStore'
import type { PluginModelRegistry } from '../providers/PluginModelRegistry'
import type { refreshProviderSpeechModels, registerProviderSpeechRpc } from '../providers/registerProviderSpeechRpc'
import type { ShellSandboxClient } from '../sandbox/ShellSandboxClient'
import type { ExtensionShellRegistry } from '../sandbox/ShellSelection'
import type { WebHostClient } from '../web/WebHostClient'

export interface RuntimePreferenceSource {
  get: () => Promise<RuntimePreferences>
  subscribe: (apply: (preferences: RuntimePreferences) => void) => () => void
}

export interface WebSecretStore {
  read: () => Promise<string | null>
  write: (key: string | null) => Promise<void>
}

export interface RuntimePlatform {
  openDesktop?: (intent: DesktopOpenIntent, signal?: AbortSignal) => Promise<DesktopOpenResult>
  privateNetworkSecrets?: { read: (id: string) => Promise<unknown | null>, write: (id: string, value: unknown) => Promise<void> }
  createCredentials: () => Pick<HostCredentialStore, keyof HostCredentialStore>
  connectorSecrets: ConnectorSecretStore
  webSecrets: WebSecretStore
  browser: BrowserCapabilityHost
  createWeb: () => Omit<WebHostClient, 'peer'>
  createSandbox: () => Pick<ShellSandboxClient, keyof ShellSandboxClient>
  createPluginImages: () => Pick<PluginImageGateway, 'models' | 'generate' | 'dispose'>
  createPluginImageBackends: (...args: [Parameters<typeof createPluginImageBackends>[1], Parameters<typeof createPluginImageBackends>[2]]) => ReturnType<typeof createPluginImageBackends>
  createImageReading: (options: Omit<ImageReadingService['options'], 'rpc'>) => Pick<ImageReadingService, 'read' | 'allowsNativeInput' | 'candidates'>
  createPluginModels: (providers: ConstructorParameters<typeof PluginModelRegistry>[1], failed: () => void) => Pick<PluginModelRegistry, 'refresh' | 'dispose'>
  createExtensionResources: (artifacts: Parameters<typeof createExtensionResourceCapabilities>[0]['artifacts'], task: Parameters<typeof createExtensionResourceCapabilities>[1], scope: Parameters<typeof createExtensionResourceCapabilities>[2]) => ReturnType<typeof createExtensionResourceCapabilities>
  imagePreferences: (signal?: AbortSignal) => Promise<ImagePreferences>
  shells: Pick<ExtensionShellRegistry, 'snapshot'>
  networkPermissions: NetworkPermissionsStore
  skills: { list: () => Promise<ExtensionSkillDescriptor[]>, subscribe: (changed: () => void) => () => void }
  capabilities: {
    list: () => Promise<ExtensionCapabilityDescriptor[]>
    subscribe: (changed: () => void) => () => void
    bind: (handlers: { impact: (extensionId: string) => Promise<ExtensionCapabilityImpact>, apply: (descriptors: ExtensionCapabilityDescriptor[], clearExtensionId: string | undefined, signal?: AbortSignal) => Promise<void> }) => () => void
  }
  subscribeShellChanges: (changed: () => void) => () => void
  subscribeSandboxReady: (ready: () => void) => () => void
  reviewSkill: (preview: SkillInstallPreview) => void
  refreshProviderSpeech: (options: Omit<Parameters<typeof refreshProviderSpeechModels>[0], 'rpc'>) => Promise<void>
  plugins: PluginAgentHost
  authoring: PluginAuthoringHost
  preferences: RuntimePreferenceSource
  openExternal: (url: string) => Promise<void>
  presentBrowser?: (source: ContextPanelSource) => Promise<void>
  executePetSequence: (input: PetExecuteSequenceParams) => Promise<PetExecuteSequenceResult>
  subscribeWake: (wake: () => void) => () => void
  bindInternal: (services: {
    attachments: Parameters<typeof registerAttachmentRpc>[0]['service']
    conditions: Omit<Parameters<typeof registerExtensionConditionRpc>[0], 'rpc'>
    speech: Omit<Parameters<typeof registerProviderSpeechRpc>[0], 'rpc'>
  }) => () => void
}
