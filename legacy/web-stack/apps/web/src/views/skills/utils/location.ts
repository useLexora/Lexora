import type { AgentLocationSkillConfig } from '@haohaoxue/lexora-contracts/agent'
import {
  AGENT_LOCATION_SKILL_KEY,
  AgentLocationSkillConfigSchema,
} from '@haohaoxue/lexora-contracts/agent'

export const LOCATION_SKILL_KEY = AGENT_LOCATION_SKILL_KEY

export interface LocationConfigFormModel {
  mode: AgentLocationSkillConfig['mode']
  fixedLocationLabel: string
}

export function parseLocationSkillConfig(config: unknown): AgentLocationSkillConfig {
  return AgentLocationSkillConfigSchema.parse(config ?? {})
}

export function createLocationConfigFormModel(config: unknown): LocationConfigFormModel {
  const parsed = parseLocationSkillConfig(config)

  return {
    mode: parsed.mode,
    fixedLocationLabel: parsed.fixedLocation?.label ?? '',
  }
}

export function toLocationSkillConfig(model: LocationConfigFormModel): AgentLocationSkillConfig {
  const fixedLocationLabel = model.fixedLocationLabel.trim()

  return AgentLocationSkillConfigSchema.parse({
    mode: model.mode,
    fixedLocation: model.mode === 'fixed' && fixedLocationLabel
      ? { label: fixedLocationLabel }
      : null,
  })
}

export function isLocationFormModelValid(model: LocationConfigFormModel): boolean {
  return model.mode === 'auto' || Boolean(model.fixedLocationLabel.trim())
}
