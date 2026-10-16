import type {
  AgentProfileConfig,
  AgentRuntimeSkillContext,
  ResolvedLanguagePreference,
} from '@haohaoxue/lexora-contracts'
import {
  AGENT_LOCATION_TOOL,
  AGENT_TIME_TOOL,
} from '@haohaoxue/lexora-contracts'
import { LANGUAGE_PREFERENCE, LANGUAGE_PREFERENCE_LABELS } from '@haohaoxue/lexora-contracts/user/constants'
import { createSkillCatalogPromptBlock } from '../skills/activation'

export const BASE_AGENT_SYSTEM_PROMPT = '你是 Lexora 的智能助手。回答准确、简洁。'

const AGENT_HISTORY_DIGEST_PROMPT_PREFIX = '较早对话摘要：'

export interface CreateAgentSystemPromptOptions {
  olderMessagesExcerpt?: string
  historyDigestSummary?: string
  agentProfileConfig?: AgentProfileConfig | null
  skillContext?: AgentRuntimeSkillContext | null
  defaultResponseLanguage?: ResolvedLanguagePreference
  timeSkillActive?: boolean
  locationSkillActive?: boolean
}

export function createAgentSystemPrompt(input: string | CreateAgentSystemPromptOptions): string {
  const options = typeof input === 'string'
    ? { olderMessagesExcerpt: input }
    : input
  const lines = [BASE_AGENT_SYSTEM_PROMPT]
  const profileConfig = options.agentProfileConfig

  lines.push(createDefaultResponseLanguageInstruction(
    options.defaultResponseLanguage ?? LANGUAGE_PREFERENCE.ZH_CN,
  ))
  if (options.timeSkillActive) {
    lines.push(createTimeSkillInstruction())
  }
  if (options.locationSkillActive) {
    lines.push(createLocationSkillInstruction())
  }

  if (profileConfig) {
    lines.push('Agent 指令：', profileConfig.instructions.systemPrompt)

    if (profileConfig.instructions.constraints.length > 0) {
      lines.push(
        '约束：',
        ...profileConfig.instructions.constraints.map(item => `- ${item}`),
      )
    }

    if (profileConfig.instructions.outputPreferences.length > 0) {
      lines.push(
        '输出偏好：',
        ...profileConfig.instructions.outputPreferences.map(item => `- ${item}`),
      )
    }

    const skillCatalog = profileConfig.toolPolicy.enabled
      ? createSkillCatalogPromptBlock(options.skillContext)
      : ''
    if (skillCatalog) {
      lines.push('可用技能：', skillCatalog)
    }
  }

  const historySummary = options.historyDigestSummary ?? options.olderMessagesExcerpt
  if (historySummary) {
    lines.push(AGENT_HISTORY_DIGEST_PROMPT_PREFIX, historySummary)
  }

  return lines.join('\n')
}

function createDefaultResponseLanguageInstruction(language: ResolvedLanguagePreference): string {
  return `默认回复语言：${LANGUAGE_PREFERENCE_LABELS[language]}。`
}

function createTimeSkillInstruction(): string {
  return [
    '时间技能：',
    `- 涉及“今天、明天、当前时间、本地日期、未来一周”等相对时间时，先调用 ${AGENT_TIME_TOOL.GET_CURRENT_TIME} 获取时间锚点。`,
    `- ${AGENT_TIME_TOOL.GET_CURRENT_TIME} 返回的是时间和日期上下文，不是地理位置、城市、国家/地区或天气位置。`,
  ].join('\n')
}

function createLocationSkillInstruction(): string {
  return [
    '位置技能：',
    `- 涉及天气、附近、本地资讯、区域政策、路线、门店等位置敏感问题时，先调用 ${AGENT_LOCATION_TOOL.GET_CURRENT_LOCATION} 获取位置上下文。`,
    `- ${AGENT_LOCATION_TOOL.GET_CURRENT_LOCATION} 返回 ok 时使用返回的位置；返回 needs_location 时先询问地点，不要联网搜索。`,
    '- 不要从时间、时区、语言、locale、服务商区域或服务端默认值推断地点。',
  ].join('\n')
}
