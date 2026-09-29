import type { z } from 'zod'
import type { ExtensionActionCause } from '../../../shared/extensions/extensionAgent'
import type { ExtensionAgentMethod } from '../../../shared/extensions/extensionAgentCapabilities'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import { extensionAgentCapabilities } from '../../../shared/extensions/extensionAgentCapabilities'

export interface ExtensionInvocationScope {
  conversationId: string
  runId: string | null
  action?: {
    id: string
    cause: ExtensionActionCause
  }
  extensionId: string
  invocationId: string
  signal: AbortSignal
}
export interface ExtensionCapabilityContext extends ExtensionInvocationScope {
  callNumber: number
}
export type ExtensionAgentHandlers = Record<ExtensionAgentMethod, (input: unknown, context: ExtensionCapabilityContext) => Promise<JsonValue>>

export function extensionAgentHandler<K extends ExtensionAgentMethod>(method: K, execute: (input: z.output<(typeof extensionAgentCapabilities)[K]['input']>, context: ExtensionCapabilityContext) => z.output<(typeof extensionAgentCapabilities)[K]['output']> | Promise<z.output<(typeof extensionAgentCapabilities)[K]['output']>>) {
  return async (input: unknown, context: ExtensionCapabilityContext): Promise<JsonValue> => {
    const contract = extensionAgentCapabilities[method]
    const params = contract.input.parse(input) as z.output<(typeof extensionAgentCapabilities)[K]['input']>
    return contract.output.parse(await execute(params, context))
  }
}
