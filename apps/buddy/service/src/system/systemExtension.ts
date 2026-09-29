import type { TSchema } from 'typebox'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { BuddyCapability } from '../agent/extensions/BuddyCapability'
import type { BuddyInProcessExtension } from '../agent/extensions/BuddyInProcessExtension'
import type { SystemActionRequest, SystemHostPort } from './systemCapability'
import type { SystemToolDetails } from './systemToolContract'
import type { SystemToolFailureCode } from './systemToolFailure'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'
import { observeSystemDiagnostics } from './observeSystemDiagnostics'

import { SystemCapabilityError, SystemCapabilityService } from './systemCapability'
import {
  classifySystemTool,
  SYSTEM_ACTION_TOOL_NAME,
  systemActionInputSchema,
} from './systemToolContract'
import {
  createSystemToolFailure,
  serializeSystemToolFailure,
} from './systemToolFailure'

export interface CreateSystemExtensionOptions {
  service: SystemCapabilityService
}

export function createSystemCapability(host: SystemHostPort, report?: ApplicationDiagnosticReporter): BuddyCapability {
  const service = new SystemCapabilityService({ host })
  const diagnostics = report ? observeSystemDiagnostics(service, report) : undefined
  return {
    async dispose() {
      try {
        await service.dispose()
      }
      finally { diagnostics?.dispose() }
    },
    extension: createSystemExtension({ service }),
    classify: (event, signal) => classifySystemTool(service, event, signal),
    disclosure: [{
      source: { kind: 'builtin', id: 'system', title: 'System' },
      exposure: 'on_demand',
      keywords: 'system process service terminate kill restart stop 系统 进程 服务 终止 杀死 停止 重启',
      tools: [{ name: SYSTEM_ACTION_TOOL_NAME }],
    }],
  }
}

export function createSystemExtension(
  options: CreateSystemExtensionOptions,
): BuddyInProcessExtension {
  return {
    name: 'lexora-system',
    factory(pi) {
      pi.registerTool(defineTool<TSchema, SystemToolDetails>({
        description: [
          'Request one supported host state change using a structured process or service selector.',
          'Use an exact PID, exact process executable name, or serviceId with its scope. Linux supports user-scope systemd service IDs; Windows supports system-scope SCM service names, not display names. Use the active Pi shell first when diagnosis or target discovery is needed.',
          'Lexora Buddy resolves one concrete target before approval and verifies the same target identity again after approval.',
          'Call this tool when the user asks for the change so Buddy can show the product approval card; do not replace it with conversational confirmation.',
          'Graceful process termination never escalates to force termination automatically.',
        ].join(' '),
        async execute(toolCallId, input, signal) {
          if (!Check(systemActionInputSchema, input))
            return invalidResult('SYSTEM_ACTION_INVALID')
          const executionSignal = signal ?? new AbortController().signal
          try {
            const receipt = await options.service.act(
              toolCallId,
              input as SystemActionRequest,
              executionSignal,
            )
            return {
              content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }],
              details: {
                effectiveEnvironment: 'host-adapter-mutation',
                receipt,
              },
              isError: receipt.status === 'failed',
            }
          }
          catch (error) {
            executionSignal.throwIfAborted()
            return errorResult(error)
          }
        },
        label: 'Change this computer',
        name: SYSTEM_ACTION_TOOL_NAME,
        parameters: systemActionInputSchema,
      }))
    },
  }
}

function invalidResult(code: SystemToolFailureCode) {
  return failureResult(code)
}

function errorResult(error: unknown) {
  const code: SystemToolFailureCode = error instanceof SystemCapabilityError
    ? error.code
    : 'SYSTEM_CAPABILITY_FAILED'
  return failureResult(code)
}

function failureResult(code: SystemToolFailureCode) {
  const failure = createSystemToolFailure(code)
  return {
    content: [{ type: 'text' as const, text: serializeSystemToolFailure(code) }],
    details: {
      code,
      effectiveEnvironment: 'host-adapter-mutation' as const,
      recoverable: failure.error.recoverable,
      ...(failure.error.recovery ? { recovery: failure.error.recovery } : {}),
    },
    isError: true,
  }
}
