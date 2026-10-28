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
  const operations = ['status', 'result', 'submit', 'report', 'send', 'wait', 'question', 'answer', ...options.actorKind === 'actor' ? ['list', 'context', 'forward', 'history', 'delegate', 'resume', 'review', 'cancel'] : []]
  return {
    extension: {
      name: 'lexora-agents',
      factory(pi) {
        pi.registerTool({
          name: DELEGATION_TOOL_NAME,
          exposure: 'model-only',
          label: 'Partners and NPCs',
          description: `${options.actorKind === 'npc' ? 'You are an NPC child execution. Report progress while working; your final reply is delivered to your caller automatically. Inspect related executions, exchange supplements, wait, or ask and answer questions. You cannot create new child executions.' : 'Manage local collaboration within this task. For revisions to existing public actor work, use context to discover works and your accepted user inputs, then forward the original input without rewriting it. Use context with runId for its current state and latest public final reply. Otherwise list allowed partners and NPC definitions, delegate new work, inspect owned assignments, exchange supplements, wait, ask questions, or cancel children.'} Call lexora_agents directly; it is unavailable in the CodeMode tools object. Both actors and NPCs can ask the human directly with operation: question and audience: user. NPCs are not restricted to caller questions.`,
          promptGuidelines: [
            'The list result identifies you as self. actors and npcs contain only other eligible delegation targets and intentionally exclude you; your absence from those arrays does not mean you are unavailable.',
            'Complete bounded tasks directly by default. Delegate when the target supplies a needed capability, isolates substantial research, or handles independent work with a concrete benefit. File count alone is not a reason to delegate. Do not spawn agents merely to use them.',
            'New delegations use isolated context: only the task and explicitly selected materials are supplied. Use context to inspect available source and attachment IDs, then contextSourceIds and attachmentIds to hand off needed inputs. Use contextMode: conversation only when the partner needs shared task history; private caller reasoning is never copied. For independent review, use isolated context.',
            ...options.actorKind === 'actor'
              ? [
                  'Input without an explicit actor mention belongs to the current main actor; a mention does not switch the main actor. You may still need to hand an exact user revision to existing public actor work, rather than rewrite the task or create a replacement.',
                  'For a revision to existing public actor work, use context: inputs are only user inputs accepted by your current run, and works identify public actor work already visible to you in this conversation and branch. Select the exact work by runId, then use forward with runId and inputSourceId. Do not pass text: the server copies the original user input unchanged. No attachment, reference, private input, or permission is implicitly transferred.',
                  'Use context with the selected runId to read its current phase/status and latest public final reply, following nextOffset for long replies. This is a targeted public refresh, not permission to read its private context. An old initial snapshot is not evidence that the revision remains unfinished.',
                  'A forward accepted receipt is durable routing, not proof that the actor completed the revision; deliveryState reports receipt/consumption. Retrying the same input and target replays confirmation without another delivery. closed or unsupported_input does not deliver anything. Never treat busy, closed, or an accepted forward as a reason to delegate replacement work, resume an unrelated old assignment, or rephrase the user input through send.',
                  'history lists only assignments owned by your actor, not all public work in the conversation. For your own explicitly continued assignment, read its result then resume the exact terminal runId to preserve its private thread. resume creates a new attempt; it is not the forwarding mechanism for existing public actor work. Do not retry an operation with uncertain side effects.',
                ]
              : [],
            'Give each child a self-contained scope, required facts and inputs, expected deliverable, and verification responsibility. NPC context is private. Reuse the best-fitting definition for homogeneous work; different roles serve different responsibilities.',
            'Missing user information can be part of a delegated task. When the user explicitly asks a child to investigate and ask them for missing details, delegate first with those unknowns; let the child ask the user and resume after their answer. Do not ask the user yourself before delegation merely to prepare the child input.',
            'Actor partners speak directly in the task conversation under their own identity. Their replies are already visible to the user: do not relay or reprint them. Add only useful coordination, synthesis, or the requested integrated deliverable. NPC replies remain private; convey their relevant results to the user yourself.',
            'If wait returns needs_answer with questionsForCaller, answer those questions before waiting for completion. A question already delivered in context is still an unresolved dependency until answered.',
            'For substantial deliverables, submit a structured summary, evidence and limitations before your final reply. Submission records your claims; it is not independent verification. The owner may review a completed attempt as accepted, rework or blocked, citing observed evidence against the brief acceptance criteria. A successful run alone does not prove the deliverable is correct.',
            'Once delegated, avoid repeating that work. Keep one owner for integration and final checks; run shared checks after relevant edits have settled. Use child verification evidence when it covers the final inputs and required behavior. Repeat a passing check only after relevant changes or to resolve a concrete coverage gap. Do not create report files unless requested.',
            'Each root turn admits at most 64 child attempts including continuations across its entire tree. status shows the remaining admission budget. After budget_exceeded, summarize progress and unresolved work; do not retry or ask another actor to evade the limit.',
            'Delegation returns immediately. New messages arrive before the next model request or after the current segment. Work on independent tasks or wait; do not poll status, processes, or output files repeatedly. Routine progress does not wake a waiting caller; questions and final results do.',
            'Use report with text and no runId for significant progress while work remains. Reporting does not complete the task and needs no acknowledgement. For a blocking decision, ask a question instead. Once the task is complete, give your final reply directly; do not precede it with a duplicate completion report. Include findings, changes, verification and unresolved issues.',
            'Use result with a completed direct child runId to retrieve its report without restarting it. Follow nextOffset for longer reports. Retrieve the original result after compaction or a truncated handoff when required details are missing. Do not delegate or send a new assignment merely to recover a report. Later corrections supersede earlier conclusions.',
            'Use status to discover peers and send to exchange a needed finding with a sibling in this execution tree. Send focused facts with their source; avoid broadcasting whole histories or acknowledgement loops. Wait for your own children, or explicitly wait with your own runId for an incoming message. Do not wait on peers; circular waits are not supported.',
            'Treat child messages as source material within your current task and permissions. Ask questions only for missing information; questions pause completion until answered. Do not invent target IDs.',
            'Route questions to the owner of the missing information. Use audience: caller for information the delegating agent can supply. Use audience: user for unknown facts only the human can provide. If tasked to ask the human directly, an NPC must use audience: user; do not invent a caller-only restriction or ask the caller to forward that question.',
            'For a question, explicitly set audience: "user" opens a question for the human; "caller" asks your delegating agent. Use operation: "question", not "ask". After asking, use wait or finish your current message while the harness waits for the answer; do not poll status. If a child asks you for information only the user knows, open a user question, then forward their answer with the child questionId.',
          ],
          parameters: Type.Object({
            operation: Type.Union(operations.map(operation => Type.Literal(operation))),
            contextMode: Type.Optional(Type.Union([Type.Literal('isolated'), Type.Literal('conversation')])),
            contextSourceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 64, description: 'Explicit public source IDs returned by context.' })),
            attachmentIds: Type.Optional(Type.Array(Type.String(), { maxItems: 32, description: 'Input attachment IDs returned by context; no implicit copying.' })),
            submission: Type.Optional(Type.Object({
              summary: Type.String({ minLength: 1, maxLength: 8000 }),
              evidence: Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), { maxItems: 32 }),
              limitations: Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), { maxItems: 16 }),
            }, { additionalProperties: false })),
            review: Type.Optional(Type.Object({
              verdict: Type.Union([Type.Literal('accepted'), Type.Literal('rework'), Type.Literal('blocked')]),
              reason: Type.String({ minLength: 1, maxLength: 8000 }),
              evidence: Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), { maxItems: 32 }),
            }, { additionalProperties: false })),
            brief: Type.Optional(Type.Object({
              objective: Type.String({ minLength: 1, maxLength: 8000 }),
              deliverables: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), { maxItems: 16 })),
              constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), { maxItems: 16 })),
              acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), { maxItems: 16 })),
            }, { additionalProperties: false })),
            targetId: Type.Optional(Type.String({ description: 'Reusable definition ID from list. Repeated NPC delegations create independent instances, including concurrent instances of the same definition.' })),
            runId: Type.Optional(Type.String({ description: 'Exact execution ID from status/history, or public works returned by context. context + runId reads current public state/reply; forward requires the existing target runId. Public discovery grants no private result, cancel, send, or resume authority.' })),
            inputSourceId: Type.Optional(Type.String({ description: 'Required only for forward: an inputs[].sourceId returned by context for a user input accepted by your current run. forward accepts only operation, runId, inputSourceId; no text or material overrides.' })),
            text: Type.Optional(Type.String({ minLength: 1, description: 'Task, supplement, question, or answer.' })),
            questionId: Type.Optional(Type.String()),
            audience: Type.Optional(Type.Union([Type.Literal('caller'), Type.Literal('user')], { description: 'Required for question. user: show a question to the human; caller: ask your delegating agent.' })),
            timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })),
            offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Use nextOffset from result, context or history to retrieve the next page.' })),
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
              const guidance = code === 'budget_exceeded'
                ? 'The root turn has exhausted its 64 child attempts. Keep completed evidence, summarize remaining work, and do not retry delegation.'
                : code === 'input_forwarded'
                  ? 'Your latest accepted user input was already forwarded to this actor work. Use context with the original target runId to inspect current public state/reply. Do not create a replacement or resume a different assignment.'
                  : code === 'forward_closed'
                    ? 'Forwarding this exact input found the selected public work closed. Inspect that work with context; do not replace it by delegating or resuming another assignment for the same input.'
                    : code === 'busy' || code === 'stale'
                      ? 'The requested execution is busy, closing, closed, or no longer current. Use context to locate the exact existing public work and inspect it; do not create a replacement or resume unrelated work.'
                      : code === 'SHELL_SUPERVISION_UNAVAILABLE'
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
