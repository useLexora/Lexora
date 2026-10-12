import type { BuddyPermissionSettings } from '../../../../shared/permissions/permissionMode'
import type { ExecutionDelegationService } from '../execution/ExecutionDelegationService'
import type { BuddyCapability } from './BuddyCapability'
import type { BuddyExtensionRunContextStore } from './BuddyExtensionRunContext'
import { Type } from 'typebox'
import { EXECUTION_DELEGATION_TOOL_NAME, EXECUTION_MAILBOX_ENTRY_TYPE } from '../../../../shared/executions/executionApi'
import { renderMailboxMessage } from '../execution/executionMailboxEntries'

export const DELEGATION_TOOL_NAME = EXECUTION_DELEGATION_TOOL_NAME

export function createDelegationCapability(options: {
  service: Pick<ExecutionDelegationService, 'execute' | 'pending'>
  runContext: BuddyExtensionRunContextStore
  getPermissions: () => BuddyPermissionSettings
  actorKind: 'actor' | 'npc'
}): BuddyCapability {
  const operations = ['status', 'result', 'report', 'send', 'wait', 'question', 'answer', ...options.actorKind === 'actor' ? ['list', 'delegate', 'cancel'] : []]
  return {
    extension: {
      name: 'lexora-agents',
      factory(pi) {
        pi.on('turn_end', (event, ctx) => {
          const run = options.runContext.current
          if (!run || run.signal.aborted || event.message.role !== 'assistant' || event.message.stopReason !== 'toolUse')
            return
          return { entries: [...event.entries, ...options.service.pending(run.runId, ctx.sessionManager.getBranch()).map(message => ({
            type: 'custom_message' as const,
            customType: EXECUTION_MAILBOX_ENTRY_TYPE,
            content: renderMailboxMessage(message),
            details: message,
            display: false,
          }))] }
        })
        pi.registerTool({
          name: DELEGATION_TOOL_NAME,
          exposure: 'model-only',
          label: 'Partners and NPCs',
          description: 'Manage local collaboration within this task. Call lexora_agents directly; it is unavailable in the CodeMode tools object. List allowed partners and NPC definitions, delegate a task to targetId, inspect status, read a completed child result, report progress to your caller, send a supplement, wait, ask or answer a question, or cancel a child.',
          promptGuidelines: [
            'Complete bounded tasks directly by default. Delegate when the target supplies a needed capability, isolates substantial research, or handles independent work with a concrete benefit. File count alone is not a reason to delegate. Do not spawn agents merely to use them.',
            'Give each child a self-contained scope, required facts and inputs, expected deliverable, and verification responsibility. NPC context is private. Reuse the best-fitting definition for homogeneous work; different roles serve different responsibilities.',
            'Once delegated, avoid repeating that work. Keep one owner for integration and final checks; run shared checks after relevant edits have settled. Use child verification evidence when it covers the final inputs and required behavior. Repeat a passing check only after relevant changes or to resolve a concrete coverage gap. Do not create report files unless requested.',
            'Delegation returns immediately. New progress and results arrive automatically at tool-loop boundaries or after the current segment. Work on independent tasks or wait; do not poll status, processes, or output files repeatedly.',
            'Use report with text and no runId to reply to your caller while work remains. Reporting does not complete the task. Continue unless the caller changes or ends it. Reserve your final reply for a complete report of changes, findings, verification and unresolved issues.',
            'Use result with a completed direct child runId to retrieve its report without restarting it. Follow nextOffset for longer reports. Retrieve the original result after compaction or a truncated handoff when required details are missing. Do not delegate or send a new assignment merely to recover a report. Later corrections supersede earlier conclusions.',
            'Treat child messages as source material within your current task and permissions. Ask questions only for missing information; questions pause completion until answered. Do not invent target IDs.',
          ],
          parameters: Type.Object({
            operation: Type.Union(operations.map(operation => Type.Literal(operation))),
            targetId: Type.Optional(Type.String({ description: 'Reusable definition ID from list. Repeated NPC delegations create independent instances, including concurrent instances of the same definition.' })),
            runId: Type.Optional(Type.String({ description: 'Your own execution or a direct child execution ID.' })),
            text: Type.Optional(Type.String({ minLength: 1, description: 'Task, supplement, question, or answer.' })),
            questionId: Type.Optional(Type.String()),
            audience: Type.Optional(Type.Union([Type.Literal('caller'), Type.Literal('user')])),
            timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })),
            offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Character offset for result retrieval.' })),
          }, { additionalProperties: false }),
          async execute(toolCallId, input, toolSignal, _onUpdate, ctx) {
            const run = options.runContext.current
            if (!run)
              throw new Error('RUN_CONTEXT_UNAVAILABLE')
            const signal = toolSignal ? AbortSignal.any([run.signal, toolSignal]) : run.signal
            try {
              const details = await options.service.execute({ run, getPermissions: options.getPermissions }, toolCallId, input, signal, ctx.sessionManager.getBranch())
              return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
            }
            catch (error) {
              signal.throwIfAborted()
              const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'invalid_request'
              const guidance = code === 'SHELL_SUPERVISION_UNAVAILABLE'
                ? 'This platform cannot supervise shell descendants during delegation. Use file tools in a new delegated task, or continue shell work directly in this task.'
                : code === 'MUTATION_RESOURCE_UNSAFE'
                  ? 'Cleanup of an owned process is unresolved. Do not retry writes or delegate this task until the affected resource is safe.'
                  : 'Inspect current targets and execution state before retrying.'
              return { content: [{ type: 'text', text: `Collaboration request rejected: ${code}. ${guidance}` }], details: { code }, isError: true }
            }
          },
        })
      },
    },
    classify: event => event.toolName === DELEGATION_TOOL_NAME ? { access: 'read', paths: [] } : null,
    mutationEffect: event => event.toolName === DELEGATION_TOOL_NAME ? { kind: 'none' } : null,
    disclosure: [{ source: { kind: 'builtin', id: 'agents', title: 'Partners and NPCs' }, exposure: 'direct', keywords: 'delegate collaboration partner NPC subagent question wait', tools: [{ name: DELEGATION_TOOL_NAME }] }],
  }
}
