import type { AgentProfileSettings } from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../auth/auth.interface'
import {
  Body,
  Controller,
  Get,
  Patch,
} from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { UpdateAgentProfileModelPolicyDto } from './agent-profile.dto'
import { AgentProfilesService } from './agent-profiles.service'

@Controller('users/me/agent/profile')
export class AgentProfilesController {
  constructor(private readonly profiles: AgentProfilesService) {}

  @Get()
  getDefaultProfile(@CurrentUser() authUser: AuthUserContext): Promise<AgentProfileSettings> {
    return this.profiles.getDefaultAgentProfileSettings(authUser.id)
  }

  @Patch('model')
  updateDefaultProfileModel(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: UpdateAgentProfileModelPolicyDto,
  ): Promise<AgentProfileSettings> {
    return this.profiles.updateDefaultAgentProfileModelPolicy(authUser.id, payload)
  }
}
