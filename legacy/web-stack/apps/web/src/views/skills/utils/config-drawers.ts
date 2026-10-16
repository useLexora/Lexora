import {
  AMAP_MCP_SKILL_KEY,
} from './amap'
import {
  LOCATION_SKILL_KEY,
} from './location'
import {
  TIME_SKILL_KEY,
} from './time'
import {
  TRANSLATOR_SKILL_KEY,
} from './translator'
import {
  WEB_SEARCH_SKILL_KEY,
} from './web-search'

export const SKILL_CONFIG_DRAWER_KEYS = [
  TIME_SKILL_KEY,
  LOCATION_SKILL_KEY,
  TRANSLATOR_SKILL_KEY,
  WEB_SEARCH_SKILL_KEY,
  AMAP_MCP_SKILL_KEY,
] as const

export type SkillConfigDrawerKey = typeof SKILL_CONFIG_DRAWER_KEYS[number]

export function hasSkillConfigDrawer(skillKey: string): skillKey is SkillConfigDrawerKey {
  return (SKILL_CONFIG_DRAWER_KEYS as readonly string[]).includes(skillKey)
}
