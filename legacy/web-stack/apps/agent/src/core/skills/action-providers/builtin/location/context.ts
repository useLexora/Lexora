import type {
  AgentLocation,
  GetCurrentLocationToolResponse,
} from '@haohaoxue/lexora-contracts'
import type { AgentGraphContext } from '../../../../state'
import {
  AGENT_LOCATION_SKILL_KEY,
  AgentLocationRuntimeInputSchema,
  AgentLocationSchema,
  AgentLocationSkillConfigSchema,
  GetCurrentLocationToolResponseSchema,
} from '@haohaoxue/lexora-contracts'
import { resolveOnlineIpLocation } from '../../../../../integrations/ip-location'

interface ResolveAgentLocationContextInput {
  fixedLocation?: AgentLocation | null
  detectedLocation?: AgentLocation | null
}

interface CreateCurrentLocationResultFromGraphContextInput {
  context: AgentGraphContext
  resolveIpLocation?: (ip: string) => Promise<AgentLocation | null>
}

export type AgentResolvedLocationContext = GetCurrentLocationToolResponse

export function resolveAgentLocationContext(input: ResolveAgentLocationContextInput): AgentResolvedLocationContext {
  const resolvedLocation = resolveDefaultLocation(input)
  if (!resolvedLocation) {
    return createNeedsLocationResult()
  }

  return createCurrentLocationOkResult(resolvedLocation)
}

export async function createCurrentLocationResultFromGraphContext(
  input: CreateCurrentLocationResultFromGraphContextInput,
): Promise<GetCurrentLocationToolResponse> {
  const config = resolveLocationSkillConfig(input.context)
  if (config.mode === 'fixed') {
    return resolveAgentLocationContext({
      fixedLocation: config.fixedLocation,
    })
  }

  const runtimeInput = resolveLocationRuntimeInput(input.context)
  if (!runtimeInput.clientIp) {
    return createNeedsLocationResult()
  }

  const ipLocation = await (input.resolveIpLocation ?? resolveOnlineIpLocation)(runtimeInput.clientIp)
  return resolveAgentLocationContext({
    detectedLocation: ipLocation,
  })
}

function resolveDefaultLocation(input: ResolveAgentLocationContextInput): {
  location: AgentLocation
} | null {
  const fixedLocation = parseOptionalLocation(input.fixedLocation)
  if (fixedLocation) {
    return {
      location: fixedLocation,
    }
  }

  const detectedLocation = parseOptionalLocation(input.detectedLocation)
  if (detectedLocation) {
    return {
      location: detectedLocation,
    }
  }

  return null
}

function resolveLocationSkillConfig(context: AgentGraphContext | undefined) {
  const binding = context?.agentProfileConfig?.skillBindings.find(item => item.key === AGENT_LOCATION_SKILL_KEY)
  const rawConfig = binding?.config ?? {}
  const result = AgentLocationSkillConfigSchema.safeParse(rawConfig)
  if (result.success) {
    return result.data
  }

  if (!isRecord(rawConfig)) {
    return AgentLocationSkillConfigSchema.parse({})
  }

  const cleanedResult = AgentLocationSkillConfigSchema.safeParse({
    mode: rawConfig.mode,
    fixedLocation: rawConfig.fixedLocation,
  })

  return cleanedResult.success ? cleanedResult.data : AgentLocationSkillConfigSchema.parse({})
}

function resolveLocationRuntimeInput(context: AgentGraphContext | undefined) {
  const rawInput = context?.runtimeHints?.skillInputs?.[AGENT_LOCATION_SKILL_KEY]
  const result = AgentLocationRuntimeInputSchema.safeParse(rawInput)
  if (result.success) {
    return result.data
  }

  if (!isRecord(rawInput)) {
    return AgentLocationRuntimeInputSchema.parse({})
  }

  const cleanedResult = AgentLocationRuntimeInputSchema.safeParse({
    clientIp: rawInput.clientIp,
  })

  return cleanedResult.success ? cleanedResult.data : AgentLocationRuntimeInputSchema.parse({})
}

function createNeedsLocationResult(): GetCurrentLocationToolResponse {
  return {
    status: 'needs_location',
    reason: 'Location is not configured.',
  }
}

function createCurrentLocationOkResult(input: {
  location: AgentLocation
}): GetCurrentLocationToolResponse {
  return GetCurrentLocationToolResponseSchema.parse({
    status: 'ok',
    location: input.location,
  })
}

function parseOptionalLocation(value: AgentLocation | null | undefined): AgentLocation | null {
  const result = AgentLocationSchema.nullable().safeParse(value ?? null)
  return result.success ? result.data : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
