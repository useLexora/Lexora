import type {
  AgentTimeZoneSource,
  GetCurrentTimeToolResponse,
} from '@haohaoxue/lexora-contracts'
import type { AgentGraphContext } from '../../../../state'
import {
  AGENT_TIME_SKILL_KEY,
  AGENT_TIME_ZONE_SOURCE,
  AgentTimeRuntimeInputSchema,
  AgentTimeSkillConfigSchema,
  AgentTimeZoneSchema,
  GetCurrentTimeToolResponseSchema,
} from '@haohaoxue/lexora-contracts'

interface ResolveAgentTimeContextInput {
  now?: Date
  profileTimeZone?: string | null
  detectedTimeZone?: string | null
}

interface CreateCurrentTimeResultInput extends ResolveAgentTimeContextInput {
  requestedTimeZone?: string
}

const SECOND_PRECISION_OPTIONS = {
  smallestUnit: 'second',
  roundingMode: 'trunc',
} as const

export type AgentResolvedTimeContext = GetCurrentTimeToolResponse

export function resolveAgentTimeContext(input: ResolveAgentTimeContextInput): AgentResolvedTimeContext {
  const resolvedTimeZone = resolveDefaultTimeZone(input)
  if (!resolvedTimeZone) {
    return createNeedsTimeZoneResult()
  }

  return createCurrentTimeOkResult({
    now: input.now ?? new Date(),
    timeZone: resolvedTimeZone.timeZone,
    timeZoneSource: resolvedTimeZone.timeZoneSource,
  })
}

export function resolveAgentTimeContextFromGraphContext(
  context: AgentGraphContext | undefined,
  now: Date = new Date(),
): AgentResolvedTimeContext {
  const config = resolveTimeSkillConfig(context)
  const runtimeInput = resolveTimeRuntimeInput(context)

  return resolveAgentTimeContext({
    now,
    profileTimeZone: config.timeZone,
    detectedTimeZone: runtimeInput.detectedTimeZone ?? null,
  })
}

export function createCurrentTimeResult(input: CreateCurrentTimeResultInput): GetCurrentTimeToolResponse {
  if (input.requestedTimeZone) {
    return createCurrentTimeOkResult({
      now: input.now ?? new Date(),
      timeZone: AgentTimeZoneSchema.parse(input.requestedTimeZone),
      timeZoneSource: AGENT_TIME_ZONE_SOURCE.ARGUMENT,
    })
  }

  return resolveAgentTimeContext(input)
}

export function createCurrentTimeResultFromGraphContext(input: {
  context: AgentGraphContext
  now?: Date
  requestedTimeZone?: string
}): GetCurrentTimeToolResponse {
  const config = resolveTimeSkillConfig(input.context)
  const runtimeInput = resolveTimeRuntimeInput(input.context)

  return createCurrentTimeResult({
    now: input.now ?? new Date(),
    requestedTimeZone: input.requestedTimeZone,
    profileTimeZone: config.timeZone,
    detectedTimeZone: runtimeInput.detectedTimeZone ?? null,
  })
}

function resolveDefaultTimeZone(input: ResolveAgentTimeContextInput): {
  timeZone: string
  timeZoneSource: AgentTimeZoneSource
} | null {
  const profileTimeZone = parseOptionalTimeZone(input.profileTimeZone)
  if (profileTimeZone) {
    return {
      timeZone: profileTimeZone,
      timeZoneSource: AGENT_TIME_ZONE_SOURCE.PROFILE,
    }
  }

  const detectedTimeZone = parseOptionalTimeZone(input.detectedTimeZone)
  if (detectedTimeZone) {
    return {
      timeZone: detectedTimeZone,
      timeZoneSource: AGENT_TIME_ZONE_SOURCE.DETECTED,
    }
  }

  return null
}

function resolveTimeSkillConfig(context: AgentGraphContext | undefined) {
  const binding = context?.agentProfileConfig?.skillBindings.find(item => item.key === AGENT_TIME_SKILL_KEY)
  const rawConfig = binding?.config ?? {}
  const result = AgentTimeSkillConfigSchema.safeParse(rawConfig)
  if (result.success) {
    return result.data
  }

  if (!isRecord(rawConfig)) {
    return AgentTimeSkillConfigSchema.parse({})
  }

  const cleanedResult = AgentTimeSkillConfigSchema.safeParse({
    timeZone: rawConfig.timeZone,
  })

  return cleanedResult.success ? cleanedResult.data : AgentTimeSkillConfigSchema.parse({})
}

function resolveTimeRuntimeInput(context: AgentGraphContext | undefined) {
  const rawInput = context?.runtimeHints?.skillInputs?.[AGENT_TIME_SKILL_KEY]
  const result = AgentTimeRuntimeInputSchema.safeParse(rawInput)
  if (result.success) {
    return result.data
  }

  if (!isRecord(rawInput)) {
    return AgentTimeRuntimeInputSchema.parse({})
  }

  const cleanedResult = AgentTimeRuntimeInputSchema.safeParse({
    detectedTimeZone: rawInput.detectedTimeZone,
  })

  return cleanedResult.success ? cleanedResult.data : AgentTimeRuntimeInputSchema.parse({})
}

function createNeedsTimeZoneResult(): GetCurrentTimeToolResponse {
  return {
    status: 'needs_timezone',
    reason: 'Time zone is not configured.',
  }
}

function createCurrentTimeOkResult(input: {
  now: Date
  timeZone: string
  timeZoneSource: AgentTimeZoneSource
}): GetCurrentTimeToolResponse {
  const zoned = Temporal.Instant
    .fromEpochMilliseconds(input.now.getTime())
    .toZonedDateTimeISO(input.timeZone)
  const today = zoned.toPlainDate()
  const todayLabel = today.toString()

  return GetCurrentTimeToolResponseSchema.parse({
    status: 'ok',
    timeZone: input.timeZone,
    timeZoneSource: input.timeZoneSource,
    nowIso: zoned.toString({
      ...SECOND_PRECISION_OPTIONS,
      timeZoneName: 'never',
    }),
    date: todayLabel,
    time: zoned.toPlainTime().toString(SECOND_PRECISION_OPTIONS),
    weekdayIso: today.dayOfWeek,
    relativeDates: {
      yesterday: today.subtract({ days: 1 }).toString(),
      today: todayLabel,
      tomorrow: today.add({ days: 1 }).toString(),
      next7DaysStart: todayLabel,
      next7DaysEnd: today.add({ days: 6 }).toString(),
    },
  })
}

function parseOptionalTimeZone(value: string | null | undefined): string | null {
  const result = AgentTimeZoneSchema.nullable().safeParse(value ?? null)
  return result.success ? result.data : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
