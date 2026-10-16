import type { UpdateAgentProfileModelPolicyRequest } from '@haohaoxue/lexora-contracts'
import { Type } from 'class-transformer'
import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator'

class AgentProfileModelRefDto {
  @IsString()
  @MaxLength(80)
  providerId!: string

  @IsString()
  @MaxLength(160)
  modelId!: string
}

export class UpdateAgentProfileModelPolicyDto implements UpdateAgentProfileModelPolicyRequest {
  @IsOptional()
  @Type(() => AgentProfileModelRefDto)
  @ValidateNested()
  modelRef!: AgentProfileModelRefDto | null
}
