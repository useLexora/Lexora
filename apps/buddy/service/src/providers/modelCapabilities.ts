import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelCapabilities, ModelCapabilityOverrides } from '../../../shared/providers/providerCapabilities'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { BUDDY_DOCUMENT_MIME_TYPES } from '../../../shared/conversation/attachmentFormats'
import { BUDDY_THINKING_LEVELS } from '../../../shared/conversation/modelSelection'
import { supportsAudioInputApi, supportsAudioInputMimeType, supportsVideoInputApi } from '../../../shared/providers/mediaInput'
import { supportsPdfInputApi } from '../../../shared/providers/pdfInput'

export type InputModel = Model<Api> & { pdfInput?: boolean, audioInput?: boolean, videoInput?: boolean, toolCall?: boolean }

export function supportsModelToolCalls(model: InputModel): boolean {
  return model.toolCall !== false
}

export function supportsModelPdfInput(model: InputModel): boolean {
  return supportsPdfInputApi(model.api) && model.pdfInput === true
}

export function supportsModelAudioInput(model: InputModel): boolean {
  return supportsAudioInputApi(model.api) && model.audioInput === true
}

export function supportsModelVideoInput(model: InputModel): boolean {
  return supportsVideoInputApi(model.api) && model.videoInput === true
}

export function supportsModelFileInput(model: InputModel, mimeType: string): boolean {
  if (mimeType === 'application/pdf')
    return supportsModelPdfInput(model)
  if (mimeType.startsWith('audio/'))
    return supportsModelAudioInput(model) && supportsAudioInputMimeType(model.api, mimeType, model.baseUrl)
  if (mimeType === 'video/mp4' || mimeType === 'video/webm')
    return supportsModelVideoInput(model)
  return false
}

export function getModelFileInputMimeTypes(model: InputModel) {
  return BUDDY_DOCUMENT_MIME_TYPES.filter(mimeType => supportsModelFileInput(model, mimeType))
}

export function readModelCapabilities(model: Model<Api>): ModelCapabilities {
  return {
    image: model.input.includes('image'),
    toolCall: supportsModelToolCalls(model),
    pdf: supportsModelPdfInput(model),
    audio: supportsModelAudioInput(model),
    video: supportsModelVideoInput(model),
    reasoningOptions: [...getSupportedThinkingLevels(model)],
  }
}

export function applyModelCapabilities(model: InputModel, overrides: ModelCapabilityOverrides | null): InputModel {
  if (!overrides)
    return model
  const input: Model<Api>['input'] = model.input.filter(value => value !== 'image')
  if (overrides.image ?? model.input.includes('image'))
    input.push('image')
  if (!input.length)
    input.push('text')
  const levels = overrides.reasoningOptions
  let thinkingLevelMap = model.thinkingLevelMap
  if (levels) {
    thinkingLevelMap = {}
    for (const level of BUDDY_THINKING_LEVELS) {
      thinkingLevelMap[level] = levels.includes(level)
        ? model.thinkingLevelMap?.[level] ?? (level === 'xhigh' || level === 'max' ? level : undefined)
        : null
    }
  }
  return {
    ...model,
    input,
    toolCall: overrides.toolCall ?? model.toolCall,
    pdfInput: supportsPdfInputApi(model.api) && (overrides.pdf ?? supportsModelPdfInput(model)),
    audioInput: supportsAudioInputApi(model.api) && (overrides.audio ?? supportsModelAudioInput(model)),
    videoInput: supportsVideoInputApi(model.api) && (overrides.video ?? supportsModelVideoInput(model)),
    reasoning: levels ? levels.some(level => level !== 'off') : model.reasoning,
    thinkingLevelMap,
  }
}
