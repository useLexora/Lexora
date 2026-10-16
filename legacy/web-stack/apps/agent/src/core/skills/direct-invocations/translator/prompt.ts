import type {
  AgentChatContextMessage,
  AgentTranslatorSkillConfig,
  AgentTranslatorTargetLanguage,
} from '@haohaoxue/lexora-contracts'
import type { DirectTranslatorInvocation } from './invocation'
import {
  AGENT_TRANSLATOR_FORMALITY,
  AGENT_TRANSLATOR_OUTPUT_MODE,
} from '@haohaoxue/lexora-contracts'

export function createDirectTranslatorSystemPrompt(invocation: DirectTranslatorInvocation): string {
  return [
    '你是 Lexora 的专用翻译助手。',
    '只翻译用户提供的正文，不回答正文问题，不补充对话历史，不使用外部上下文。',
    '自动识别源语言。',
    `targetLanguage: ${formatTranslatorTargetLanguage(invocation.targetLanguage)}`,
    'sameLanguageInput: 如果源文本已经接近目标语言，仍按目标语言自然表达，不询问、不解释。',
    `preserveFormatting: ${invocation.config.preserveFormatting ? 'true' : 'false'}`,
    `outputMode: ${formatTranslatorOutputMode(invocation.config.outputMode)}`,
    `formality: ${formatTranslatorFormality(invocation.config.formality)}`,
    '除非 outputMode 要求双语或注释，否则只输出译文。',
  ].join('\n')
}

export function createDirectTranslatorHumanContent(message: AgentChatContextMessage): string {
  return [
    '[需要翻译的正文]',
    message.content,
  ].join('\n')
}

function formatTranslatorTargetLanguage(language: AgentTranslatorTargetLanguage): string {
  return language.tag ? `${language.name} [${language.tag}]` : language.name
}

function formatTranslatorOutputMode(mode: AgentTranslatorSkillConfig['outputMode']): string {
  if (mode === AGENT_TRANSLATOR_OUTPUT_MODE.BILINGUAL) {
    return 'bilingual'
  }

  if (mode === AGENT_TRANSLATOR_OUTPUT_MODE.WITH_NOTES) {
    return 'translation with brief notes'
  }

  return 'translation only'
}

function formatTranslatorFormality(formality: AgentTranslatorSkillConfig['formality']): string {
  if (formality === AGENT_TRANSLATOR_FORMALITY.FORMAL) {
    return 'formal'
  }

  if (formality === AGENT_TRANSLATOR_FORMALITY.CASUAL) {
    return 'casual'
  }

  if (formality === AGENT_TRANSLATOR_FORMALITY.NEUTRAL) {
    return 'neutral'
  }

  return 'auto'
}
