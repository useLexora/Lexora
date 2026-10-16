import type {
  ActivateAgentSkillRequest,
  ActivateAgentSkillResponse,
} from '@haohaoxue/lexora-contracts'
import { ActivateAgentSkillRequestSchema } from '@haohaoxue/lexora-contracts'
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common'
import { Public } from '../../decorators/public.decorator'
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe'
import { AgentSkillsService } from './agent-skills.service'

@Controller('internal/agent/skills')
export class AgentSkillsInternalController {
  constructor(private readonly skills: AgentSkillsService) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('activate')
  activateSkill(
    @Body(new ZodValidationPipe(ActivateAgentSkillRequestSchema)) payload: ActivateAgentSkillRequest,
  ): Promise<ActivateAgentSkillResponse> {
    return this.skills.activateSkill(payload)
  }
}
