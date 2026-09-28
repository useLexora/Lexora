import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import type {
  Automation,
  AutomationDefinitionDraft,
  AutomationOccurrence,
  AutomationSchedule,
} from '../../../shared/automation'
import type { AutomationApprovalReviewInput } from '../../../shared/permissions/approvalReviewPayload'
import type { BuddyToolClassificationResult } from '../approvals/toolClassification'
import type { AutomationService } from './AutomationService'
import type {
  AutomationToolDetails,
  AutomationToolOperation,
} from './automationToolContract'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { z } from 'zod'

import {
  automationDefinitionDraftSchema,
  automationMutationRequestSchemas,
  automationRequestSchemas,
} from '../../../shared/automation'
import { createToolClassificationFailure } from '../approvals/toolClassification'
import { AutomationServiceError } from './AutomationService'
import { AUTOMATION_TOOL_NAME } from './automationToolContract'

const id = Type.String({ maxLength: 256, minLength: 1 })
const requestId = Type.String({ maxLength: 128, minLength: 1 })
const utcInstant = Type.String({ minLength: 1 })
const localDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
const localTime = Type.String({ pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' })
const timezone = Type.String({ maxLength: 256, minLength: 1 })
const weekdays = Type.Array(Type.Integer({ maximum: 7, minimum: 1 }), {
  maxItems: 7,
  minItems: 1,
})

const schedule = Type.Union([
  Type.Object({
    cadence: Type.Literal('daily'),
    kind: Type.Literal('calendar'),
    localTime,
  }, { additionalProperties: false }),
  Type.Object({
    cadence: Type.Literal('weekly'),
    kind: Type.Literal('calendar'),
    localTime,
    weekdays,
  }, { additionalProperties: false }),
  Type.Object({
    cadence: Type.Literal('monthly'),
    dayOfMonth: Type.Union([
      Type.Integer({ maximum: 31, minimum: 1 }),
      Type.Literal('last'),
    ]),
    kind: Type.Literal('calendar'),
    localTime,
  }, { additionalProperties: false }),
  Type.Object({
    cadence: Type.Literal('yearly'),
    day: Type.Integer({ maximum: 31, minimum: 1 }),
    kind: Type.Literal('calendar'),
    localTime,
    month: Type.Integer({ maximum: 12, minimum: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    anchorAt: utcInstant,
    every: Type.Number({ maximum: 168, minimum: 1, multipleOf: 0.1 }),
    kind: Type.Literal('interval'),
    unit: Type.Literal('hour'),
  }, { additionalProperties: false }),
  Type.Object({
    anchorAt: utcInstant,
    every: Type.Integer({ maximum: 365, minimum: 1 }),
    kind: Type.Literal('interval'),
    unit: Type.Literal('day'),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('once'),
    runAt: utcInstant,
  }, { additionalProperties: false }),
])

const draft = Type.Object({
  executionProfile: Type.Optional(Type.Union([
    Type.Literal('read_only'),
    Type.Literal('workspace_write'),
    Type.Literal('full_access'),
  ])),
  model: Type.Union([
    Type.Object({ mode: Type.Literal('default') }, { additionalProperties: false }),
    Type.Object({
      mode: Type.Literal('pinned'),
      modelId: id,
      providerId: id,
      reasoning: Type.Union([
        Type.Literal('off'),
        Type.Literal('minimal'),
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high'),
        Type.Literal('xhigh'),
        Type.Literal('max'),
        Type.Null(),
      ]),
    }, { additionalProperties: false }),
  ]),
  name: Type.String({ maxLength: 80, minLength: 1 }),
  spaceId: Type.Union([id, Type.Null()]),
  prompt: Type.String({ maxLength: 32 * 1024, minLength: 1 }),
  timing: Type.Object({
    activeFrom: Type.Union([localDate, Type.Null()]),
    activeUntil: Type.Union([localDate, Type.Null()]),
    schedule,
    timezone,
  }, { additionalProperties: false }),
}, { additionalProperties: false })

const target = {
  automationId: id,
  expectedRevision: Type.Integer({ minimum: 1 }),
  requestId,
} as const

export const automationToolParameters = Type.Union([
  Type.Object({
    cursor: Type.Optional(Type.String({ maxLength: 2_048, minLength: 1 })),
    limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
    operation: Type.Literal('list'),
    statuses: Type.Optional(Type.Array(Type.Union([
      Type.Literal('active'),
      Type.Literal('paused'),
      Type.Literal('blocked'),
      Type.Literal('completed'),
    ]), { maxItems: 4 })),
  }, { additionalProperties: false }),
  Type.Object({
    automationId: id,
    operation: Type.Literal('get'),
  }, { additionalProperties: false }),
  Type.Object({
    draft,
    operation: Type.Literal('upsert'),
    requestId,
  }, { additionalProperties: false }),
  Type.Object({
    ...target,
    draft,
    operation: Type.Literal('upsert'),
  }, { additionalProperties: false }),
  ...(['pause', 'resume', 'delete', 'run_now'] as const).map(operation => Type.Object({
    ...target,
    operation: Type.Literal(operation),
  }, { additionalProperties: false })),
], { type: 'object' })

export interface CreateAutomationToolOptions {
  service: AutomationService
}

const automationToolInputSchema = z.union([
  automationRequestSchemas.list.extend({ operation: z.literal('list') }),
  automationRequestSchemas.get.extend({ operation: z.literal('get') }),
  automationMutationRequestSchemas.create.extend({ operation: z.literal('upsert') }),
  automationMutationRequestSchemas.update.extend({ operation: z.literal('upsert') }),
  automationMutationRequestSchemas.pause.extend({ operation: z.literal('pause') }),
  automationMutationRequestSchemas.resume.extend({ operation: z.literal('resume') }),
  automationMutationRequestSchemas.delete.extend({ operation: z.literal('delete') }),
  automationMutationRequestSchemas.runNow.extend({ operation: z.literal('run_now') }),
])

export function createAutomationTool(options: CreateAutomationToolOptions) {
  return defineTool<TSchema, AutomationToolDetails>({
    description: [
      'List, inspect, create, update, pause, resume, delete, or immediately queue Lexora Buddy automations.',
      'Use list/get before mutating an existing automation so expectedRevision is current.',
      'For upsert, omit automationId and expectedRevision to create; provide both to update.',
      'executionProfile defaults to workspace_write; use read_only for inspection-only automations and full_access only when the user explicitly requests unrestricted local access.',
      'Calendar schedules support daily, weekly, monthly, and yearly cadences; interval and once schedules are also supported.',
      'Mutations always pause for a product confirmation card. Do not replace that confirmation with a conversational question.',
      'run_now only queues one occurrence and returns immediately.',
    ].join(' '),
    async execute(_toolCallId, input) {
      if (!Check(automationToolParameters, input))
        return failure('invalid', 'VALIDATION_FAILED')
      const parsed = automationToolInputSchema.safeParse(input)
      if (!parsed.success)
        return failure(readOperation(input), 'VALIDATION_FAILED')
      try {
        const result = executeAutomationOperation(options.service, parsed.data)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result.value) }],
          details: result.details,
          isError: false,
        }
      }
      catch (error) {
        return failure(parsed.data.operation, readAutomationErrorCode(error))
      }
    },
    label: 'Manage Lexora Buddy automations',
    name: AUTOMATION_TOOL_NAME,
    parameters: automationToolParameters,
  })
}

export function classifyAutomationTool(
  service: AutomationService,
  toolName: string,
  input: unknown,
): BuddyToolClassificationResult | null {
  if (toolName !== AUTOMATION_TOOL_NAME)
    return null
  if (!Check(automationToolParameters, input))
    return createToolClassificationFailure('VALIDATION_FAILED')
  const parsed = automationToolInputSchema.safeParse(input)
  if (!parsed.success)
    return createToolClassificationFailure('VALIDATION_FAILED')
  if (parsed.data.operation === 'list' || parsed.data.operation === 'get') {
    return {
      access: 'read',
    }
  }
  const automation = parsed.data.operation === 'upsert'
    ? automationDefinitionDraftSchema.parse(parsed.data.draft)
    : service.get(parsed.data.automationId)
  if (!automation)
    return createToolClassificationFailure('AUTOMATION_NOT_FOUND')
  return {
    forceAsk: true,
    approval: {
      automation: createAutomationReview(parsed.data.operation, automation),
      kind: 'automation',
      summary: `${automationOperationLabel(parsed.data.operation)} automation ${automation.name}`,
    },
  }
}

function executeAutomationOperation(
  service: AutomationService,
  input: z.infer<typeof automationToolInputSchema>,
): {
  automation?: Automation
  changed?: boolean
  details: AutomationToolDetails
  occurrence?: AutomationOccurrence
  value: unknown
} {
  switch (input.operation) {
    case 'list': {
      const { operation: _, ...request } = input
      const page = service.list(request)
      return { details: { operation: input.operation, page }, value: page }
    }
    case 'get': {
      const automation = requireAutomation(service, input.automationId)
      return {
        automation,
        details: { automation, operation: input.operation },
        value: automation,
      }
    }
    case 'upsert': {
      const { operation: _, ...request } = input
      const automation = 'automationId' in request
        ? service.update(request)
        : service.create(request)
      return {
        automation,
        details: { automation, operation: input.operation },
        value: automation,
      }
    }
    case 'pause':
    case 'resume':
    case 'delete': {
      const { operation: _, ...request } = input
      const automation = service[input.operation](request)
      return {
        automation,
        details: { automation, operation: input.operation },
        value: automation,
      }
    }
    case 'run_now': {
      const { operation: _, ...request } = input
      const result = service.runNow(request)
      return {
        changed: result.outcome === 'started',
        details: {
          occurrence: result.occurrence,
          operation: input.operation,
          runNowOutcome: result.outcome,
        },
        occurrence: result.occurrence,
        value: result,
      }
    }
  }
}

function createAutomationReview(
  operation: AutomationApprovalReviewInput['operation'],
  automation: AutomationDefinitionDraft,
): AutomationApprovalReviewInput {
  return {
    executionProfile: automation.executionProfile,
    modelMode: automation.model.mode === 'default'
      ? 'default'
      : `pinned: ${automation.model.providerId}/${automation.model.modelId}`,
    name: automation.name,
    operation,
    spaceId: automation.spaceId,
    promptSummary: summarize(automation.prompt, 512),
    scheduleSummary: summarizeSchedule(automation.timing.schedule),
    timezone: automation.timing.timezone,
  }
}

function summarizeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === 'once')
    return `once at ${schedule.runAt}`
  if (schedule.kind === 'interval')
    return `every ${schedule.every} ${schedule.unit}${schedule.every === 1 ? '' : 's'} from ${schedule.anchorAt}`
  switch (schedule.cadence) {
    case 'daily': return `daily at ${schedule.localTime}`
    case 'weekly': return `weekly on ${schedule.weekdays.join(',')} at ${schedule.localTime}`
    case 'monthly': return `monthly on ${schedule.dayOfMonth} at ${schedule.localTime}`
    case 'yearly': return `yearly on ${schedule.month}-${schedule.day} at ${schedule.localTime}`
  }
}

function summarize(value: string, maxLength: number): string {
  const characters = Array.from(value.trim())
  return characters.length <= maxLength
    ? characters.join('')
    : `${characters.slice(0, maxLength - 1).join('')}…`
}

function requireAutomation(service: AutomationService, id: string): Automation {
  const automation = service.get(id)
  if (!automation)
    throw new AutomationServiceError('AUTOMATION_NOT_FOUND')
  return automation
}

function automationOperationLabel(operation: AutomationApprovalReviewInput['operation']): string {
  switch (operation) {
    case 'upsert': return 'Save'
    case 'pause': return 'Pause'
    case 'resume': return 'Resume'
    case 'delete': return 'Delete'
    case 'run_now': return 'Run now'
  }
}

function failure(operation: AutomationToolDetails['operation'], code: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: { code } }),
    }],
    details: { code, operation },
    isError: true,
  }
}

function readAutomationErrorCode(error: unknown): string {
  return error instanceof AutomationServiceError
    ? error.code
    : 'AUTOMATION_OPERATION_FAILED'
}

function readOperation(input: unknown): AutomationToolDetails['operation'] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'invalid'
  const operation = (input as { operation?: unknown }).operation
  return typeof operation === 'string' && new Set([
    'list',
    'get',
    'upsert',
    'pause',
    'resume',
    'delete',
    'run_now',
  ]).has(operation)
    ? operation as AutomationToolOperation
    : 'invalid'
}

export function classifyAutomationToolCall(
  service: AutomationService,
  event: ToolCallEvent,
): BuddyToolClassificationResult | null {
  return classifyAutomationTool(service, event.toolName, event.input)
}
