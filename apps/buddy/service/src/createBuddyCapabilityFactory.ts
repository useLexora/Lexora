import type { ContextPanelSource } from '../../shared/context-panel/contextPanel'
import type { ApplicationDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import type { BuddyFeatureId, BuddyPlatform } from '../../shared/platform'
import type { RuntimeRpcPeerContract } from '../../shared/runtime/rpcPeer'
import type { BuddyCapability, BuddyCapabilityContext, BuddyCapabilityFactory } from './agent/extensions/BuddyCapability'
import type { ArtifactService } from './artifacts/ArtifactService'
import type { CreateAutomationToolOptions } from './automations/createAutomationTool'
import type { BrowserCapabilityHost } from './browser/BrowserCapabilityService'
import type { McpConnectorService } from './connectors/mcp/McpConnectorService'
import type { SessionReferenceServices } from './conversations/SessionReferenceService'
import type { ImageGenerationGateway } from './images/ImageGenerationGateway'
import type { ImageGenerationServiceOptions } from './images/ImageGenerationService'
import type { ImageTransformService } from './images/ImageTransformService'
import type { PetActionService } from './pet/PetActionService'
import type { PluginAuthoringService } from './plugins/PluginAuthoringService'
import type { WebCapabilityService } from './web/WebCapabilityService'
import { createOutputPresentationCapability } from './artifacts/outputPresentationExtension'
import { createAutomationCapability } from './automations/automationExtension'
import { createBrowserCapability } from './browser/browserExtension'
import { createMcpCapability } from './connectors/mcp/mcpExtension'
import { createMcpResultWriter } from './connectors/mcp/McpResultStore'
import { createSessionReferenceCapability } from './conversations/sessionReferenceExtension'
import { createImageGenerationCapability } from './images/imageGenerationExtension'
import { ImageGenerationService } from './images/ImageGenerationService'
import { observeImageDiagnostics } from './images/ImageOperationLifecycle'
import { createImageTransformCapability } from './images/imageTransformExtension'
import { createPetCapability } from './pet/petExtension'
import { createPluginAuthoringCapability } from './plugins/pluginAuthoringCapability'
import { createSystemHost } from './system/createSystemHost'
import { createSystemCapability } from './system/systemExtension'
import { createWebCapability } from './web/webExtension'

export interface BuddyCapabilityServices {
  record?: ApplicationDiagnosticReporter
  pluginCapabilities?: (context: BuddyCapabilityContext) => Promise<BuddyCapability[]>
  pluginAuthoring: Pick<RuntimeRpcPeerContract, 'request' | 'notify'>
  pluginBuilder: PluginAuthoringService
  artifactService: ImageGenerationServiceOptions['artifactService'] & Pick<ArtifactService, 'presentOutputs'> & SessionReferenceServices['artifacts']
  attachmentService: ImageGenerationServiceOptions['attachmentService'] & SessionReferenceServices['attachments']
  automationService: CreateAutomationToolOptions['service']
  browserHost: BrowserCapabilityHost
  presentBrowser: (source: ContextPanelSource) => Promise<void>
  connectorService: Pick<McpConnectorService, 'getTools'>
  imageGenerationGateway: ImageGenerationGateway
  imageTransformService: Pick<ImageTransformService, 'removeChroma'>
  webService: Pick<WebCapabilityService, 'search' | 'fetch'>
  conversations: SessionReferenceServices['conversations']
  eventLog: SessionReferenceServices['eventLog']
}

export function createBuddyCapabilityFactory(
  platform: BuddyPlatform,
  services: BuddyCapabilityServices,
  pet: PetActionService,
): BuddyCapabilityFactory {
  const platformFactories: Record<BuddyFeatureId, () => (context: BuddyCapabilityContext) => BuddyCapability> = {
    nativePet() {
      return context => createPetCapability({ getRunId: context.getRunId, service: pet })
    },
    systemActions() {
      const host = createSystemHost(platform.id)
      return () => createSystemCapability(host, services.record)
    },
  }
  const supported = platform.features.map(id => platformFactories[id]())
  return async (context) => {
    context.signal.throwIfAborted()
    const mcp = services.connectorService.getTools(context.signal, context.executionProfile === 'read_only' ? undefined : createMcpResultWriter({ ...context, artifactService: services.artifactService }))
    context.signal.throwIfAborted()
    const capabilities = [
      createMcpCapability(mcp, context.isCodemodeEnabled ?? (() => false)),
      createBrowserCapability({
        report: services.record,
        conversationId: context.conversationId,
        getGrants: () => context.grants,
        getExecutionGrants: context.getExecutionGrants,
        host: services.browserHost,
        onOpened: context.sessionMode === 'interactive'
          ? async () => {
            const runId = context.getRunId()
            if (runId)
              await services.presentBrowser({ conversationId: context.conversationId, runId })
          }
          : undefined,
      }),
      createWebCapability({ service: services.webService, conversationId: context.conversationId }),
      createImageCapability(context, services),
      createImageTransformCapability({ ...context, service: services.imageTransformService }),
      createOutputPresentationCapability({ ...context, artifactService: services.artifactService }),
      createSessionReferenceCapability({ conversationId: context.conversationId, conversations: services.conversations, attachments: services.attachmentService, artifacts: services.artifactService, eventLog: services.eventLog }),
      ...supported.map(create => create(context)),
    ]
    try {
      if (context.sessionMode === 'interactive') {
        capabilities.push(...await services.pluginCapabilities?.(context) ?? [])
        capabilities.push(createPluginAuthoringCapability(context, services.pluginAuthoring, services.pluginBuilder))
        capabilities.push(createAutomationCapability({
          service: services.automationService,
        }))
      }
      context.signal.throwIfAborted()
      return capabilities
    }
    catch (error) {
      const results = await Promise.allSettled(capabilities.map(async capability => capability.dispose?.()))
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length)
        throw new AggregateError([error, ...failures.map(result => result.reason)], 'CAPABILITY_INITIALIZATION_FAILED')
      throw error
    }
  }
}

function createImageCapability(context: BuddyCapabilityContext, services: BuddyCapabilityServices): BuddyCapability {
  const service = new ImageGenerationService({
    artifactService: services.artifactService,
    attachmentService: services.attachmentService,
    conversationId: context.conversationId,
    cwd: context.cwd,
    get grants() { return context.grants },
    imageGenerationGateway: services.imageGenerationGateway,
  })
  const diagnostics = services.record ? observeImageDiagnostics(service, services.record) : null
  return {
    ...createImageGenerationCapability({ getRunId: context.getRunId, getExecutionGrants: context.getExecutionGrants, service }),
    async dispose() {
      await service.dispose()
      diagnostics?.dispose()
    },
  }
}
