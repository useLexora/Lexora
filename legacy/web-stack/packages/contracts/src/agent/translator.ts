import { z } from 'zod'

const NonEmptyStringSchema = z.string().trim().min(1)

export const AGENT_TRANSLATOR_SKILL_KEY = 'lexora.translator' as const

export const AGENT_TRANSLATOR_OUTPUT_MODE = {
  TRANSLATION_ONLY: 'translation_only',
  BILINGUAL: 'bilingual',
  WITH_NOTES: 'with_notes',
} as const

export const AGENT_TRANSLATOR_OUTPUT_MODE_VALUES = [
  AGENT_TRANSLATOR_OUTPUT_MODE.TRANSLATION_ONLY,
  AGENT_TRANSLATOR_OUTPUT_MODE.BILINGUAL,
  AGENT_TRANSLATOR_OUTPUT_MODE.WITH_NOTES,
] as const

export const AGENT_TRANSLATOR_FORMALITY = {
  AUTO: 'auto',
  NEUTRAL: 'neutral',
  FORMAL: 'formal',
  CASUAL: 'casual',
} as const

export const AGENT_TRANSLATOR_FORMALITY_VALUES = [
  AGENT_TRANSLATOR_FORMALITY.AUTO,
  AGENT_TRANSLATOR_FORMALITY.NEUTRAL,
  AGENT_TRANSLATOR_FORMALITY.FORMAL,
  AGENT_TRANSLATOR_FORMALITY.CASUAL,
] as const

export const AGENT_TRANSLATOR_PRESET_TARGET_LANGUAGES = [
  { tag: 'zh', name: '中文' },
  { tag: 'en', name: 'English' },
  { tag: 'ja', name: '日本語' },
  { tag: 'ko', name: '한국어' },
  { tag: 'fr', name: 'Français' },
  { tag: 'de', name: 'Deutsch' },
  { tag: 'es', name: 'Español' },
  { tag: 'it', name: 'Italiano' },
  { tag: 'pt', name: 'Português' },
  { tag: 'ru', name: 'Русский' },
  { tag: 'ar', name: 'العربية' },
  { tag: 'vi', name: 'Tiếng Việt' },
  { tag: 'th', name: 'ไทย' },
  { tag: 'id', name: 'Bahasa Indonesia' },
] as const

export const AgentTranslatorOutputModeSchema = z.enum(AGENT_TRANSLATOR_OUTPUT_MODE_VALUES)
export const AgentTranslatorFormalitySchema = z.enum(AGENT_TRANSLATOR_FORMALITY_VALUES)

export const AgentTranslatorTargetLanguageSchema = z.object({
  tag: z.string().trim().min(1).optional(),
  name: NonEmptyStringSchema,
}).strict()

export const AgentTranslatorSkillConfigSchema = z.object({
  preserveFormatting: z.boolean().default(true),
  outputMode: AgentTranslatorOutputModeSchema.default(AGENT_TRANSLATOR_OUTPUT_MODE.TRANSLATION_ONLY),
  formality: AgentTranslatorFormalitySchema.default(AGENT_TRANSLATOR_FORMALITY.AUTO),
}).strict()

export const AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG = AgentTranslatorSkillConfigSchema.parse({})

export const AGENT_TRANSLATOR_SKILL_MANIFEST = {
  title: '翻译',
  description: '自动识别源语言，并按本轮指令或默认配置翻译为目标语言。',
  tools: [],
} as const

export type AgentTranslatorOutputMode = z.infer<typeof AgentTranslatorOutputModeSchema>
export type AgentTranslatorFormality = z.infer<typeof AgentTranslatorFormalitySchema>
export type AgentTranslatorTargetLanguage = z.infer<typeof AgentTranslatorTargetLanguageSchema>
export type AgentTranslatorSkillConfig = z.infer<typeof AgentTranslatorSkillConfigSchema>
