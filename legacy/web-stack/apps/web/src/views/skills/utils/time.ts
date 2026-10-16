import type { AgentTimeSkillConfig } from '@haohaoxue/lexora-contracts/agent'
import {
  AGENT_TIME_SKILL_KEY,
  AgentTimeSkillConfigSchema,
} from '@haohaoxue/lexora-contracts/agent'
import { resolveBrowserTimeZone } from '@/utils/time-zone'

export const TIME_SKILL_KEY = AGENT_TIME_SKILL_KEY

export interface TimeConfigFormModel {
  timeZone: string
}

export function parseTimeSkillConfig(config: unknown): AgentTimeSkillConfig {
  return AgentTimeSkillConfigSchema.parse(config ?? {})
}

export function createTimeConfigFormModel(config: unknown): TimeConfigFormModel {
  const parsed = parseTimeSkillConfig(config)

  return {
    timeZone: parsed.timeZone ?? '',
  }
}

export function toTimeSkillConfig(model: TimeConfigFormModel): AgentTimeSkillConfig {
  const timeZone = model.timeZone.trim()
  return AgentTimeSkillConfigSchema.parse({
    timeZone: timeZone || null,
  })
}

export function isTimeZoneFormValueValid(value: string): boolean {
  return AgentTimeSkillConfigSchema.safeParse({
    timeZone: value.trim() || null,
  }).success
}

export function getDetectedBrowserTimeZone(): string | null {
  return resolveBrowserTimeZone()
}
