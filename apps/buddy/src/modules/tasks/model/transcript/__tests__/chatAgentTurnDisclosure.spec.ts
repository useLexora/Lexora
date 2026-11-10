import { runSchema } from '@buddy-shared/runs/runApi'
import { describe, expect, it } from 'vitest'
import { translateBuddy } from '@/i18n/buddyMessages'
import { resolveChatAgentTurnFailurePresentation } from '../chatAgentTurnDisclosure'

describe('local inference failure disclosure', () => {
  it.each([
    ['MODEL_ENGINE_TOO_OLD', 'desktop.chat.modelEngineTooOld', /更新引擎/, /update the engine/],
    ['MODEL_ARCHITECTURE_UNSUPPORTED', 'desktop.chat.modelArchitectureUnsupported', /不支持此模型架构/, /does not support this model architecture/],
    ['MODEL_QUANTIZATION_UNSUPPORTED', 'desktop.chat.modelQuantizationUnsupported', /不支持此模型的量化格式/, /does not support this model quantization/],
    ['MODEL_DRIVER_INCOMPATIBLE', 'desktop.chat.modelDriverIncompatible', /显卡驱动/, /GPU driver/],
    ['MODEL_BACKEND_UNAVAILABLE', 'desktop.chat.modelBackendUnavailable', /切换可用的推理后端/, /switch to an available backend/],
    ['MODEL_REQUEST_TIMED_OUT', 'desktop.chat.modelRequestTimedOut', /超时/, /timed out/],
  ] as const)('presents %s with actionable messages in both locales', (code, key, zh, en) => {
    const presentation = resolveChatAgentTurnFailurePresentation(runSchema.shape.errorCode.parse(code), code)
    expect(presentation).toEqual({ messageKey: key, message: null, detail: null })
    expect(translateBuddy('zh-CN', presentation.messageKey)).toMatch(zh)
    expect(translateBuddy('en-US', presentation.messageKey)).toMatch(en)
  })
})
