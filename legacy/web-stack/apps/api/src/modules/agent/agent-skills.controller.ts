import type {
  ListAgentSkillsResponse,
  MutateAgentSkillParams,
  MutateAgentSkillResponse,
  UpdateAgentSkillConfigParams,
  UpdateAgentSkillConfigRequest,
  UpdateAgentSkillConfigResponse,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../auth/auth.interface'
import {
  MutateAgentSkillParamsSchema,
  UpdateAgentSkillConfigParamsSchema,
  UpdateAgentSkillConfigRequestSchema,
} from '@haohaoxue/lexora-contracts'
import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe'
import { AgentSkillsService } from './agent-skills.service'

@Controller('users/me/agent/skills')
export class AgentSkillsController {
  constructor(private readonly skills: AgentSkillsService) {}

  @Get()
  listDefaultAgentSkills(@CurrentUser() authUser: AuthUserContext): Promise<ListAgentSkillsResponse> {
    return this.skills.listDefaultAgentSkills(authUser.id)
  }

  @Post(':skillKey/install')
  installDefaultAgentSkill(
    @CurrentUser() authUser: AuthUserContext,
    @Param(new ZodValidationPipe(MutateAgentSkillParamsSchema)) params: MutateAgentSkillParams,
  ): Promise<MutateAgentSkillResponse> {
    return this.skills.installDefaultAgentSkill(authUser.id, params.skillKey)
  }

  @Post(':skillKey/enable')
  enableDefaultAgentSkill(
    @CurrentUser() authUser: AuthUserContext,
    @Param(new ZodValidationPipe(MutateAgentSkillParamsSchema)) params: MutateAgentSkillParams,
  ): Promise<MutateAgentSkillResponse> {
    return this.skills.enableDefaultAgentSkill(authUser.id, params.skillKey)
  }

  @Post(':skillKey/disable')
  disableDefaultAgentSkill(
    @CurrentUser() authUser: AuthUserContext,
    @Param(new ZodValidationPipe(MutateAgentSkillParamsSchema)) params: MutateAgentSkillParams,
  ): Promise<MutateAgentSkillResponse> {
    return this.skills.disableDefaultAgentSkill(authUser.id, params.skillKey)
  }

  @Delete(':skillKey')
  uninstallDefaultAgentSkill(
    @CurrentUser() authUser: AuthUserContext,
    @Param(new ZodValidationPipe(MutateAgentSkillParamsSchema)) params: MutateAgentSkillParams,
  ): Promise<MutateAgentSkillResponse> {
    return this.skills.uninstallDefaultAgentSkill(authUser.id, params.skillKey)
  }

  @Patch(':skillKey/config')
  updateDefaultAgentSkillConfig(
    @CurrentUser() authUser: AuthUserContext,
    @Param(new ZodValidationPipe(UpdateAgentSkillConfigParamsSchema)) params: UpdateAgentSkillConfigParams,
    @Body(new ZodValidationPipe(UpdateAgentSkillConfigRequestSchema)) body: UpdateAgentSkillConfigRequest,
  ): Promise<UpdateAgentSkillConfigResponse> {
    return this.skills.updateDefaultAgentSkillConfig(authUser.id, params.skillKey, body.config)
  }
}
