import type { AiProviderPreset } from '@haohaoxue/lexora-contracts'
import { Injectable, NotFoundException } from '@nestjs/common'
import {
  AI_BUILTIN_PROVIDER_PRESETS,
  AI_COMPATIBLE_PROVIDER_PRESETS,
  AI_PROVIDER_PRESETS,
} from '../ai.registry'

@Injectable()
export class AiProviderPresetsService {
  getPresets(): AiProviderPreset[] {
    return this.clonePresets(AI_BUILTIN_PROVIDER_PRESETS)
  }

  getCompatiblePresets(): AiProviderPreset[] {
    return this.clonePresets(AI_COMPATIBLE_PROVIDER_PRESETS)
  }

  getPresetOrThrow(providerKey: string): AiProviderPreset {
    const preset = AI_PROVIDER_PRESETS.find(item => item.providerKey === providerKey)

    if (!preset) {
      throw new NotFoundException(`服务商预设不存在：${providerKey}`)
    }

    return {
      ...preset,
      supportedModelTypes: [...preset.supportedModelTypes],
    }
  }

  private clonePresets(presets: readonly AiProviderPreset[]): AiProviderPreset[] {
    return presets.map(preset => ({
      ...preset,
      supportedModelTypes: [...preset.supportedModelTypes],
    }))
  }
}
