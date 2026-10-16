import type { AuthCapabilities } from '@haohaoxue/lexora-contracts'
import { Controller, Get } from '@nestjs/common'
import { Public } from '../../decorators/public.decorator'
import { CapabilitiesService } from './capabilities.service'

@Controller('capabilities')
export class CapabilitiesController {
  constructor(private readonly capabilitiesService: CapabilitiesService) {}

  @Public()
  @Get('auth')
  async getAuthCapabilities(): Promise<AuthCapabilities> {
    return this.capabilitiesService.getAuthCapabilities()
  }
}
