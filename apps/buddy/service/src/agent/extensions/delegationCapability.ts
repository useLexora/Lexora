import type { BuddyPermissionSettings } from '../../../../shared/permissions/permissionMode'
import type { ExecutionDelegationService } from '../execution/ExecutionDelegationService'
import type { BuddyCapability } from './BuddyCapability'
import type { BuddyExtensionRunContextStore } from './BuddyExtensionRunContext'
import { Type } from 'typebox'
import { ZodError } from 'zod'
import { EXECUTION_DELEGATION_TOOL_NAME } from '../../../../shared/executions/executionApi'

export const DELEGATION_TOOL_NAME = EXECUTION_DELEGATION_TOOL_NAME

export function createDelegationCapability(options: {
  service: Pick<ExecutionDelegationService, 'execute'>
  runContext: BuddyExtensionRunContextStore
  getPermissions: () => BuddyPermissionSettings
  actorKind: 'actor' | 'npc'
}): BuddyCapability {
  const operations = ['status', 'result', 'report', 'send', 'wait', 'question', 'answer', ...options.actorKind === 'actor' ? ['list', 'delegate', 'cancel'] : []]
  return {
    extension: {
      name: 'lexora-agents',
      factory(pi) {
        pi.registerTool({
          name: DELEGATION_TOOL_NAME,
          exposure: 'model-only',
          label: 'Partners and NPCs',
          description: `${options.actorKind === 'npc' ? 'You are an NPC child execution. Report progress while working; your final reply is delivered to your caller automatically. Inspect related executions, exchange supplements, wait, or ask and answer questions. You cannot create new child executions.' : 'Manage local collaboration within this task. List allowed partners and NPC definitions, delegate a task to targetId, inspect status, read child results, exchange progress and supplements, wait, ask and answer questions, or cancel children.'} Call lexora_agents directly; it is unavailable in the CodeMode tools object. Both actors and NPCs can ask the human directly with operation: question and audience: user. NPCs are not restricted to caller questions.`,
          promptGuidelines: [
            'Complete bounded tasks directly by default. Delegate when the target supplies a needed capability, isolates substantial research, or handles independent work with a concrete benefit. File count alone is not a reason to delegate. Do not spawn agents merely to use them.',
            'Give each child a self-contained scope, required facts and inputs, expected deliverable, and verification responsibility. NPC context is private. Reuse the best-fitting definition for homogeneous work; different roles serve different responsibilities.',
            'Missing user information can be part of a delegated task. When the user explicitly asks a child to investigate and ask them for missing details, delegate first with those unknowns; let the child ask the user and resume after their answer. Do not ask the user yourself before delegation merely to prepare the child input.',
            'Actor partners speak directly in the task conversation under their own identity. Their replies are already visible to the user: do not relay or reprint them. Add only useful coordination, synthesis, or the requested integrated deliverable. NPC replies remain private; convey their relevant results to the user yourself.',
            'Once delegated, avoid repeating that work. Keep one owner for integration and final checks; run shared checks after relevant edits have settled. Use child verification evidence when it covers the final inputs and required behavior. Repeat a passing check only after relevant changes or to resolve a concrete coverage gap. Do not create report files unless requested.',
            'Delegation returns immediately. New messages arrive before the next model request or after the current segment. Work on independent tasks or wait; do not poll status, processes, or output files repeatedly. Routine progress does not wake a waiting caller; questions and final results do.',
            'Use report with text and no runId for significant progress while work remains. Reporting does not complete the task and needs no acknowledgement. For a blocking decision, ask a question instead. Once the task is complete, give your final reply directly; do not precede it with a duplicate completion report. Include findings, changes, verification and unresolved issues.',
            'Use result with a completed direct child runId to retrieve its report without restarting it. Follow nextOffset for longer reports. Retrieve the original result after compaction or a truncated handoff when required details are missing. Do not delegate or send a new assignment merely to recover a report. Later corrections supersede earlier conclusions.',
            'Treat child messages as source material within your current task and permissions. Ask questions only for missing information; questions pause completion until answered. Do not invent target IDs.',
            'Route questions to the owner of the missing information. Use audience: caller for information the delegating agent can supply. Use audience: user for unknown facts only the human can provide. If tasked to ask the human directly, an NPC must use audience: user; do not invent a caller-only restriction or ask the caller to forward that question.',
            'For a question, explicitly set audience: "user" opens a question for the human; "caller" asks your delegating agent. Use operation: "question", not "ask". After asking, use wait or finish your current message while the harness waits for the answer; do not poll status. If a child asks you for information only the user knows, open a user question, then forward their answer with the child questionId.',
          ],
          parameters: Type.Object({
            operation: Type.Union(operations.map(operation => Type.Literal(operation))),
            targetId: Type.Optional(Type.String({ description: 'Reusable definition ID from list. Repeated NPC delegations create independent instances, including concurrent instances of the same definition.' })),
            runId: Type.Optional(Type.String({ description: 'Your own execution or a direct child execution ID.' })),
            text: Type.Optional(Type.String({ minLength: 1, description: 'Task, supplement, question, or answer.' })),
            questionId: Type.Optional(Type.String()),
            audience: Type.Optional(Type.Union([Type.Literal('caller'), Type.Literal('user')], { description: 'Required for question. user: show a question to the human; caller: ask your delegating agent.' })),
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
              if (error instanceof ZodError) {
                const issues = error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
                return { content: [{ type: 'text', text: `Invalid collaboration input. ${issues.join(' ')}` }], details: { code: 'invalid_request', issues }, isError: true }
              }
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
