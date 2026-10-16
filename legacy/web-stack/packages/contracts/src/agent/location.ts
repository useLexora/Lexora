import { z } from 'zod'

const NonEmptyStringSchema = z.string().trim().min(1)

export const AGENT_LOCATION_SKILL_KEY = 'lexora.location' as const

export const AGENT_LOCATION_TOOL = {
  GET_CURRENT_LOCATION: 'get_current_location',
} as const

export const AGENT_LOCATION_TOOL_VALUES = [
  AGENT_LOCATION_TOOL.GET_CURRENT_LOCATION,
] as const

export const AGENT_LOCATION_SOURCE = {
  FIXED: 'fixed',
  ONLINE_IP: 'online_ip',
} as const

export const AGENT_LOCATION_SOURCE_VALUES = [
  AGENT_LOCATION_SOURCE.FIXED,
  AGENT_LOCATION_SOURCE.ONLINE_IP,
] as const

export const AGENT_LOCATION_DEFAULT_SKILL_CONFIG = {
  mode: 'auto',
  fixedLocation: null,
} as const

export const AgentLocationToolNameSchema = z.enum(AGENT_LOCATION_TOOL_VALUES)
export const AgentLocationSourceSchema = z.enum(AGENT_LOCATION_SOURCE_VALUES)
export const AgentLocationSkillModeSchema = z.enum(['auto', 'fixed'])

export const AgentLocationCoordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative().optional(),
}).strict()

export const AgentLocationSchema = z.object({
  label: NonEmptyStringSchema.max(100).optional(),
  coordinates: AgentLocationCoordinatesSchema.optional(),
}).strict().refine(
  value => Boolean(value.label || value.coordinates),
  'Location must include a label or coordinates.',
)

export const AgentFixedLocationSchema = z.object({
  label: NonEmptyStringSchema.max(100),
}).strict()

export const AgentLocationSkillConfigSchema = z.object({
  mode: AgentLocationSkillModeSchema.default(AGENT_LOCATION_DEFAULT_SKILL_CONFIG.mode),
  fixedLocation: AgentFixedLocationSchema.nullable().default(AGENT_LOCATION_DEFAULT_SKILL_CONFIG.fixedLocation),
}).strict().superRefine((value, ctx) => {
  if (value.mode !== 'fixed' || value.fixedLocation) {
    return
  }

  ctx.addIssue({
    code: 'custom',
    path: ['fixedLocation'],
    message: 'Fixed location is required when location mode is fixed.',
  })
}).default(AGENT_LOCATION_DEFAULT_SKILL_CONFIG)

export const AgentLocationRuntimeInputSchema = z.object({
  clientIp: NonEmptyStringSchema.max(64).optional(),
}).strict().default({})

export const GetCurrentLocationOkResponseSchema = z.object({
  status: z.literal('ok'),
  location: AgentLocationSchema,
}).strict()

export const GetCurrentLocationNeedsLocationResponseSchema = z.object({
  status: z.literal('needs_location'),
  reason: NonEmptyStringSchema,
}).strict()

export const GetCurrentLocationToolResponseSchema = z.discriminatedUnion('status', [
  GetCurrentLocationOkResponseSchema,
  GetCurrentLocationNeedsLocationResponseSchema,
])

export const AGENT_LOCATION_SKILL_MANIFEST = {
  title: '位置',
  description: '提供用户固定配置或服务端自动粗定位的位置，用于天气、附近、本地资讯、区域政策等位置敏感问题。',
  tools: [
    {
      name: AGENT_LOCATION_TOOL.GET_CURRENT_LOCATION,
      title: '获取当前位置',
      description: '返回用户固定配置或自动检测的位置；没有位置时返回需要地点。',
    },
  ],
} as const

export type AgentLocationToolName = z.infer<typeof AgentLocationToolNameSchema>
export type AgentLocationSource = z.infer<typeof AgentLocationSourceSchema>
export type AgentLocationSkillMode = z.infer<typeof AgentLocationSkillModeSchema>
export type AgentLocation = z.infer<typeof AgentLocationSchema>
export type AgentFixedLocation = z.infer<typeof AgentFixedLocationSchema>
export type AgentLocationCoordinates = z.infer<typeof AgentLocationCoordinatesSchema>
export type AgentLocationSkillConfig = z.infer<typeof AgentLocationSkillConfigSchema>
export type AgentLocationRuntimeInput = z.infer<typeof AgentLocationRuntimeInputSchema>
export type GetCurrentLocationOkResponse = z.infer<typeof GetCurrentLocationOkResponseSchema>
export type GetCurrentLocationNeedsLocationResponse = z.infer<typeof GetCurrentLocationNeedsLocationResponseSchema>
export type GetCurrentLocationToolResponse = z.infer<typeof GetCurrentLocationToolResponseSchema>
