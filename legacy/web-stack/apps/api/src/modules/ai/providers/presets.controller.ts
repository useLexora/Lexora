import type { AiProviderPreset } from '@haohaoxue/lexora-contracts'
import { Controller, Get } from '@nestjs/common'
import { AiProviderPresetsService } from './presets.service'

@Controller('ai')
export class AiProviderPresetsController {
  constructor(private readonly presetsService: AiProviderPresetsService) {}

  @Get('provider-presets')
  getPresets(): AiProviderPreset[] {
    return this.presetsService.getPresets()
  }

  @Get('provider-presets/compatible')
  getCompatiblePresets(): AiProviderPreset[] {
    return this.presetsService.getCompatiblePresets()
  }
}
