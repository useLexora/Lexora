import type {
  AgentTranslatorFormality,
  AgentTranslatorOutputMode,
  AgentTranslatorSkillConfig,
} from '@haohaoxue/lexora-contracts/agent'
import {
  AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG,
  AGENT_TRANSLATOR_FORMALITY,
  AGENT_TRANSLATOR_OUTPUT_MODE,
  AGENT_TRANSLATOR_SKILL_KEY,
  AgentTranslatorSkillConfigSchema,
} from '@haohaoxue/lexora-contracts/agent'

export const TRANSLATOR_SKILL_KEY = AGENT_TRANSLATOR_SKILL_KEY

type Translate = (key: string) => string

export function createTranslatorOutputModeOptions(t: Translate): Array<{ label: string, value: AgentTranslatorOutputMode }> {
  return [
    { label: t('skills.translator.translationOnly'), value: AGENT_TRANSLATOR_OUTPUT_MODE.TRANSLATION_ONLY },
    { label: t('skills.translator.bilingual'), value: AGENT_TRANSLATOR_OUTPUT_MODE.BILINGUAL },
    { label: t('skills.translator.withNotes'), value: AGENT_TRANSLATOR_OUTPUT_MODE.WITH_NOTES },
  ]
}

export function createTranslatorFormalityOptions(t: Translate): Array<{ label: string, value: AgentTranslatorFormality }> {
  return [
    { label: t('skills.translator.auto'), value: AGENT_TRANSLATOR_FORMALITY.AUTO },
    { label: t('skills.translator.neutral'), value: AGENT_TRANSLATOR_FORMALITY.NEUTRAL },
    { label: t('skills.translator.formal'), value: AGENT_TRANSLATOR_FORMALITY.FORMAL },
    { label: t('skills.translator.casual'), value: AGENT_TRANSLATOR_FORMALITY.CASUAL },
  ]
}

export interface TranslatorConfigFormModel {
  preserveFormatting: boolean
  outputMode: AgentTranslatorOutputMode
  formality: AgentTranslatorFormality
}

export function parseTranslatorSkillConfig(config: unknown): AgentTranslatorSkillConfig {
  return AgentTranslatorSkillConfigSchema.parse(config ?? AGENT_TRANSLATOR_DEFAULT_SKILL_CONFIG)
}

export function createTranslatorConfigFormModel(config: unknown): TranslatorConfigFormModel {
  const parsed = parseTranslatorSkillConfig(config)

  return {
    preserveFormatting: parsed.preserveFormatting,
    outputMode: parsed.outputMode,
    formality: parsed.formality,
  }
}

export function toTranslatorSkillConfig(model: TranslatorConfigFormModel): AgentTranslatorSkillConfig {
  return AgentTranslatorSkillConfigSchema.parse({
    preserveFormatting: model.preserveFormatting,
    outputMode: model.outputMode,
    formality: model.formality,
  })
}
