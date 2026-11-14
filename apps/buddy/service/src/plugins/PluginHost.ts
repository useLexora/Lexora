import type { z } from 'zod'
import type { ExtensionAgentCatalog, ExtensionAgentDescriptor, ExtensionAgentInvocation, extensionAgentRequestSchema } from '../../../shared/extensions/extensionAgent'
import type { extensionCapabilitiesRequestSchema, extensionCapabilitiesSchema, extensionIdentityRequestSchema, extensionIdentitySchema, ExtensionInspection, extensionTransferRequestSchema } from '../../../shared/extensions/extensionAuthoring'
import type { JsonValue } from '../../../shared/workbench/workbenchState'

export interface PluginAgentHost {
  releaseRun?: (runId: string) => Promise<void>
  list: (signal: AbortSignal) => Promise<ExtensionAgentDescriptor[]>
  invoke: (input: ExtensionAgentInvocation, signal: AbortSignal) => Promise<JsonValue>
  subscribe: (apply: (catalog: ExtensionAgentCatalog) => void) => () => void
  bindInference: (handlers: { acquire: (input: { extensionId: string, invocationId: string, parentInvocationId?: string }, signal?: AbortSignal) => Promise<null>, release: (invocationId: string) => null }) => () => void
  bind: (handler: (input: z.infer<typeof extensionAgentRequestSchema>, signal?: AbortSignal) => Promise<JsonValue>) => () => void
}

export interface PluginAuthoringHost {
  transfer: (input: z.infer<typeof extensionTransferRequestSchema>, signal?: AbortSignal) => Promise<unknown>
  review: (path: string) => void
  identity: (input: z.infer<typeof extensionIdentityRequestSchema>, signal: AbortSignal) => Promise<z.infer<typeof extensionIdentitySchema>>
  capabilities: (input: z.infer<typeof extensionCapabilitiesRequestSchema>, signal: AbortSignal) => Promise<z.infer<typeof extensionCapabilitiesSchema>>
  inspect: (id: string, signal: AbortSignal) => Promise<ExtensionInspection>
}
