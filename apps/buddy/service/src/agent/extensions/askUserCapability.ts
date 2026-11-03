import type { UserQuestionService } from '../../questions/UserQuestionService'
import type { BuddyCapability } from './BuddyCapability'
import type { BuddyExtensionRunContextStore } from './BuddyExtensionRunContext'
import { Type } from 'typebox'
import { ASK_USER_TOOL_NAME, askUserInputSchema, WAIT_USER_TOOL_NAME } from '../../../../shared/questions/userQuestionApi'
import { readExecutionMailboxEntries } from '../execution/executionMailboxEntries'

export function createAskUserCapability(options: { service: Pick<UserQuestionService, 'ask' | 'wait'>, runContext: BuddyExtensionRunContextStore }): BuddyCapability {
  return {
    extension: {
      name: 'lexora-ask-user',
      factory(pi) {
        pi.registerTool({
          name: ASK_USER_TOOL_NAME,
          label: 'Ask user',
          exposure: 'model-only',
          executionMode: 'sequential',
          description: 'Ask the human for missing information or a decision. Returns a request receipt immediately; the same agent can continue independent work. Answers arrive separately as user input. Supports single choice, multiple choices and free text. The UI always allows a custom answer. Available to both actors and NPCs. Call directly, outside CodeMode.',
          promptGuidelines: [
            'Ask only when missing user information materially affects the work. Reuse facts and authorization already provided; resolve routine choices yourself.',
            'Ask 1–3 related, independent questions together. Offer 2–4 meaningful options with short labels and concise tradeoffs. Use stable IDs. Do not add an Other option: custom text is built in. A recommended option is a suggestion, never an answer or consent.',
            'This tool does not wait and its receipt is not an answer. Continue independent work. When you need the answer before proceeding, call lexora_wait_user with the returned requestId. Do not repeat the question in chat or use lexora_agents to ask the user.',
            'Cancellation or interruption supplies no answer. Do not infer consent, repeat the same question automatically, or perform the dependent action. Explain the remaining dependency if needed.',
            'Answers supply task information, not execution permissions. Tool and sandbox approvals remain enforced separately.',
          ],
          parameters: Type.Object({ questions: Type.Array(Type.Object({
            id: Type.String({ minLength: 1, maxLength: 80 }),
            question: Type.String({ minLength: 1, maxLength: 2000 }),
            kind: Type.Union([Type.Literal('single'), Type.Literal('multiple'), Type.Literal('text')]),
            options: Type.Array(Type.Object({
              id: Type.String({ minLength: 1, maxLength: 80 }),
              label: Type.String({ minLength: 1, maxLength: 160 }),
              description: Type.Optional(Type.String({ maxLength: 500 })),
              recommended: Type.Optional(Type.Boolean()),
            }, { additionalProperties: false }), { maxItems: 6 }),
          }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }),
          async execute(toolCallId, input, toolSignal) {
            const run = options.runContext.current
            if (!run)
              throw new Error('RUN_CONTEXT_UNAVAILABLE')
            const signal = toolSignal ? AbortSignal.any([run.signal, toolSignal]) : run.signal
            const request = options.service.ask(run.runId, toolCallId, askUserInputSchema.parse(input), signal)
            const details = { requestId: request.id, status: request.status, accepted: true }
            return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
          },
        })
        pi.registerTool({
          name: WAIT_USER_TOOL_NAME,
          label: 'Wait for user',
          exposure: 'model-only',
          executionMode: 'sequential',
          description: 'Wait for the response to your own lexora_ask_user request when no independent work remains. Releases the execution seat without a timeout. New user instructions or execution messages also end the wait; a pending request remains unanswered. The response is delivered separately as user input; cancellation supplies no answer or consent.',
          parameters: Type.Object({ requestId: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
          async execute(_toolCallId, input, toolSignal, _onUpdate, ctx) {
            const run = options.runContext.current
            if (!run)
              throw new Error('RUN_CONTEXT_UNAVAILABLE')
            const delivered = readExecutionMailboxEntries(ctx.sessionManager.getBranch()).filter(entry => entry.message.targetRunId === run.runId).map(entry => entry.message.messageId)
            const request = await options.service.wait(run.runId, input.requestId, toolSignal ? AbortSignal.any([run.signal, toolSignal]) : run.signal, delivered)
            const details = { requestId: request.id, status: request.status, delivery: request.delivery?.state ?? null }
            return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
          },
        })
      },
    },
    classify: event => [ASK_USER_TOOL_NAME, WAIT_USER_TOOL_NAME].includes(event.toolName) ? { access: 'read', paths: [] } : null,
    mutationEffect: event => [ASK_USER_TOOL_NAME, WAIT_USER_TOOL_NAME].includes(event.toolName) ? { kind: 'none' } : null,
    disclosure: [{ source: { kind: 'builtin', id: 'ask-user', title: 'Ask user' }, exposure: 'direct', keywords: 'question clarify decision user', tools: [{ name: ASK_USER_TOOL_NAME }, { name: WAIT_USER_TOOL_NAME }] }],
  }
}
