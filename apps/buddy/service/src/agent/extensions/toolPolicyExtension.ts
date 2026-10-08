import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import type { BuddyToolClassificationResult } from '../../approvals/toolClassification'
import type { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import type { BuddyExtensionRunContext } from './BuddyExtensionRunContext'
import type { BuddyInProcessExtension } from './BuddyInProcessExtension'
import { isToolClassificationFailure } from '../../approvals/toolClassification'
import { readToolCallBlockReason } from '../../permissions/permissionContract'

export interface CreateToolPolicyExtensionOptions {
  authorization: ToolAuthorizationService
  classifyTool?: (
    event: ToolCallEvent,
    run: BuddyExtensionRunContext,
  ) => BuddyToolClassificationResult | null | undefined | Promise<BuddyToolClassificationResult | null | undefined>
  getRunContext: () => BuddyExtensionRunContext | null
}

export function createToolPolicyExtension(options: CreateToolPolicyExtensionOptions): BuddyInProcessExtension {
  return {
    name: 'lexora-tool-policy',
    factory(pi) {
      pi.on('tool_call', async (event) => {
        try {
          const run = options.getRunContext()
          if (!run)
            return block('RUN_CONTEXT_UNAVAILABLE')
          const signal = event.signal ? AbortSignal.any([run.signal, event.signal]) : run.signal
          signal.throwIfAborted()
          const classification = await options.classifyTool?.(event, event.signal ? { ...run, signal } : run)
          signal.throwIfAborted()
          const reason = classification && isToolClassificationFailure(classification)
            ? classification.reason
            : await options.authorization.authorize(event, run, classification ?? {}, { signal })
          if (reason) {
            await run.onToolExecutionDenied?.({ denialCode: reason, toolCallId: event.toolCallId, toolName: event.toolName })
            return block(reason)
          }
          signal.throwIfAborted()
          await run.onToolExecutionAuthorized({
            arguments: event.input,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          })
        }
        catch (error) {
          return block(readToolCallBlockReason(error) ?? 'TOOL_POLICY_FAILED')
        }
      })
    },
  }
}

function block(reason: string): ToolCallEventResult {
  return { block: true, reason, terminate: false }
}
