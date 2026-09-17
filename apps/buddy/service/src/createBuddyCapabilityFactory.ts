import type { ContextPanelSource } from '../../shared/context-panel/contextPanel'
import type { BuddyFeatureId, BuddyPlatform } from '../../shared/platform'
import type { BuddyCapability, BuddyCapabilityContext, BuddyCapabilityFactory } from './agent/extensions/BuddyCapability'
import type { ArtifactService } from './artifacts/ArtifactService'
import type { CreateAutomationToolOptions } from './automations/createAutomationTool'
import type { BrowserCapabilityHost } from './browser/BrowserCapabilityService'
import type { McpConnectorService } from './connectors/mcp/McpConnectorService'
import type { ImageGenerationGateway } from './images/ImageGenerationGateway'
import type { ImageGenerationServiceOptions } from './images/ImageGenerationService'
import type { ImageTransformService } from './images/ImageTransformService'
import type { PetActionServiceOptions } from './pet/PetActionService'
import type { WebCapabilityService } from './web/WebCapabilityService'
import { createOutputPresentationCapability } from './artifacts/outputPresentationExtension'
import { createAutomationCapability } from './automations/automationExtension'
import { createBrowserCapability } from './browser/browserExtension'
import { createMcpCapability } from './connectors/mcp/mcpExtension'
import { createMcpResultWriter } from './connectors/mcp/McpResultStore'
import { createImageGenerationCapability } from './images/imageGenerationExtension'
import { ImageGenerationService } from './images/ImageGenerationService'
import { createImageTransformCapability } from './images/imageTransformExtension'
import { PetActionService } from './pet/PetActionService'
import { createPetCapability } from './pet/petExtension'
import { createSystemHost } from './system/createSystemHost'
import { createSystemCapability } from './system/systemExtension'
import { createWebCapability } from './web/webExtension'

export interface BuddyCapabilityServices {
  artifactService: ImageGenerationServiceOptions['artifactService'] & Pick<ArtifactService, 'presentOutputs'>
  attachmentService: ImageGenerationServiceOptions['attachmentService']
  automationService: CreateAutomationToolOptions['service']
  browserHost: BrowserCapabilityHost
  presentBrowser: (source: ContextPanelSource) => Promise<void>
  connectorService: Pick<McpConnectorService, 'getTools'>
  imageGenerationGateway: ImageGenerationGateway
  imageTransformService: Pick<ImageTransformService, 'removeChroma'>
  onAutomationChanged: (automationId: string) => void
  webService: Pick<WebCapabilityService, 'search' | 'fetch'>
}

export function createBuddyCapabilityFactory(
  platform: BuddyPlatform,
  services: BuddyCapabilityServices,
  pet: PetActionServiceOptions,
): BuddyCapabilityFactory {
  const platformFactories: Record<BuddyFeatureId, () => (context: BuddyCapabilityContext) => BuddyCapability> = {
    nativePet() {
      const service = new PetActionService(pet)
      return context => createPetCapability({ getRunId: context.getRunId, service })
    },
    systemActions() {
      const host = createSystemHost(platform.id)
      return () => createSystemCapability(host)
    },
  }
  const supported = platform.features.map(id => platformFactories[id]())
  return async (context) => {
    context.signal.throwIfAborted()
    const mcp = services.connectorService.getTools(context.signal, context.executionProfile === 'read_only' ? undefined : createMcpResultWriter({ ...context, artifactService: services.artifactService }))
    context.signal.throwIfAborted()
    const capabilities = [
      createMcpCapability(mcp),
      createBrowserCapability({
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
      createImageGenerationCapability({
        getRunId: context.getRunId,
        getExecutionGrants: context.getExecutionGrants,
        service: new ImageGenerationService({
          artifactService: services.artifactService,
          attachmentService: services.attachmentService,
          conversationId: context.conversationId,
          cwd: context.cwd,
          grants: context.grants,
          imageGenerationGateway: services.imageGenerationGateway,
        }),
      }),
      createImageTransformCapability({ ...context, service: services.imageTransformService }),
      createOutputPresentationCapability({ ...context, artifactService: services.artifactService }),
      ...supported.map(create => create(context)),
    ]
    if (context.sessionMode === 'interactive') {
      capabilities.push(createAutomationCapability({
        onChanged: services.onAutomationChanged,
        service: services.automationService,
      }))
    }
    return capabilities
  }
}
