import { z } from 'zod'

const NonEmptyStringSchema = z.string().trim().min(1)

export const AGENT_TIME_SKILL_KEY = 'lexora.time' as const

export const AGENT_TIME_TOOL = {
  GET_CURRENT_TIME: 'get_current_time',
} as const

export const AGENT_TIME_TOOL_VALUES = [
  AGENT_TIME_TOOL.GET_CURRENT_TIME,
] as const

export const AGENT_TIME_ZONE_SOURCE = {
  ARGUMENT: 'argument',
  PROFILE: 'profile',
  DETECTED: 'detected',
} as const

export const AGENT_TIME_ZONE_SOURCE_VALUES = [
  AGENT_TIME_ZONE_SOURCE.ARGUMENT,
  AGENT_TIME_ZONE_SOURCE.PROFILE,
  AGENT_TIME_ZONE_SOURCE.DETECTED,
] as const

export const AGENT_TIME_DEFAULT_SKILL_CONFIG = {
  timeZone: null as string | null,
}

export const AgentTimeToolNameSchema = z.enum(AGENT_TIME_TOOL_VALUES)
export const AgentTimeZoneSourceSchema = z.enum(AGENT_TIME_ZONE_SOURCE_VALUES)

export const AgentTimeZoneSchema = NonEmptyStringSchema.refine(
  isValidIanaTimeZone,
  'Invalid IANA time zone.',
)

export const AgentTimeSkillConfigSchema = z.object({
  timeZone: AgentTimeZoneSchema.nullable().default(AGENT_TIME_DEFAULT_SKILL_CONFIG.timeZone),
}).strict().default(AGENT_TIME_DEFAULT_SKILL_CONFIG)

export const AgentTimeRuntimeInputSchema = z.object({
  detectedTimeZone: AgentTimeZoneSchema.nullable().optional(),
}).strict().default({})

export const CurrentTimeRelativeDatesSchema = z.object({
  yesterday: z.string().date(),
  today: z.string().date(),
  tomorrow: z.string().date(),
  next7DaysStart: z.string().date(),
  next7DaysEnd: z.string().date(),
}).strict()

export const GetCurrentTimeOkResponseSchema = z.object({
  status: z.literal('ok'),
  timeZone: AgentTimeZoneSchema,
  timeZoneSource: AgentTimeZoneSourceSchema,
  nowIso: NonEmptyStringSchema,
  date: z.string().date(),
  time: NonEmptyStringSchema,
  weekdayIso: z.number().int().min(1).max(7),
  relativeDates: CurrentTimeRelativeDatesSchema,
}).strict()

export const GetCurrentTimeNeedsTimeZoneResponseSchema = z.object({
  status: z.literal('needs_timezone'),
  reason: NonEmptyStringSchema,
}).strict()

export const GetCurrentTimeToolResponseSchema = z.discriminatedUnion('status', [
  GetCurrentTimeOkResponseSchema,
  GetCurrentTimeNeedsTimeZoneResponseSchema,
])

export const AGENT_TIME_SKILL_MANIFEST = {
  title: '时间',
  description: '提供当前时间、日期和相对日期锚点，帮助理解“今天、明天、未来一周”等相对时间。',
  tools: [
    {
      name: AGENT_TIME_TOOL.GET_CURRENT_TIME,
      title: '获取当前时间',
      description: '按指定或已配置的 IANA 时区返回当前时间、日期和相对日期锚点。',
    },
  ],
} as const

export type AgentTimeToolName = z.infer<typeof AgentTimeToolNameSchema>
export type AgentTimeZoneSource = z.infer<typeof AgentTimeZoneSourceSchema>
export type AgentTimeSkillConfig = z.infer<typeof AgentTimeSkillConfigSchema>
export type AgentTimeRuntimeInput = z.infer<typeof AgentTimeRuntimeInputSchema>
export type CurrentTimeRelativeDates = z.infer<typeof CurrentTimeRelativeDatesSchema>
export type GetCurrentTimeOkResponse = z.infer<typeof GetCurrentTimeOkResponseSchema>
export type GetCurrentTimeNeedsTimeZoneResponse = z.infer<typeof GetCurrentTimeNeedsTimeZoneResponseSchema>
export type GetCurrentTimeToolResponse = z.infer<typeof GetCurrentTimeToolResponseSchema>

function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date('2026-01-01T00:00:00.000Z'))
    return true
  }
  catch {
    return false
  }
}
