import { runSchema } from '@buddy-shared/runs/runApi'
import { describe, expect, it } from 'vitest'
import { translateBuddy } from '@/i18n/buddyMessages'
import { resolveChatAgentTurnFailurePresentation } from '../chatAgentTurnDisclosure'

describe('local inference failure disclosure', () => {
  it.each([
    ['MODEL_LAUNCH_QUOTA_EXCEEDED', 'desktop.chat.modelLaunchQuotaExceeded', /准备启动目录.*配额已用尽/, /storage quota.*launch directory/],
    ['MODEL_LAUNCH_NO_SPACE', 'desktop.chat.modelLaunchNoSpace', /没有足够的空间准备启动目录/, /no space left.*launch directory/],
    ['MODEL_STORAGE_QUOTA_EXCEEDED', 'desktop.chat.modelStorageQuotaExceeded', /配额已用尽，具体位置未知/, /quota.*location is unknown/],
    ['MODEL_STORAGE_NO_SPACE', 'desktop.chat.modelStorageNoSpace', /磁盘空间不足.*具体位置未知/, /no space.*location is unknown/],
    ['MODEL_STORAGE_FULL', 'desktop.chat.modelStorageFull', /磁盘空间或用户配额/, /storage is full or has reached its quota/],
  ] as const)('uses only the safe storage facts for %s in both locales', (code, key, zh, en) => {
    const presentation = resolveChatAgentTurnFailurePresentation(code, '/private/fixture')
    expect(presentation).toEqual({ messageKey: key, message: null, detail: null })
    expect(translateBuddy('zh-CN', presentation.messageKey)).toMatch(zh)
    expect(translateBuddy('en-US', presentation.messageKey)).toMatch(en)
  })

  it('only displays the directory recorded for this launch failure', () => {
    const code = 'MODEL_LAUNCH_NO_SPACE'
    const location = '<profile>/cache/extensions/fixture.local/launches'
    const record = { version: 1, code, location }
    expect(resolveChatAgentTurnFailurePresentation(code, null, record).detail).toBe(location)
    expect(resolveChatAgentTurnFailurePresentation(code, location).detail).toBeNull()
    expect(resolveChatAgentTurnFailurePresentation(code, 'EXTENSION_INFERENCE_LAUNCH_NO_SPACE').detail).toBeNull()
    expect(resolveChatAgentTurnFailurePresentation('MODEL_LAUNCH_QUOTA_EXCEEDED', null, record).detail).toBeNull()
  })

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
