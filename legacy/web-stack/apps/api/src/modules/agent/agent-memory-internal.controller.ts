import type {
  ExecuteAgentMemoryOperationProposalsRequest,
  ExecuteAgentMemoryOperationProposalsResponse,
  RetrieveAgentMemoryRequest,
  RetrieveAgentMemoryResponse,
} from '@haohaoxue/lexora-contracts'
import {
  ExecuteAgentMemoryOperationProposalsRequestSchema,
  ExecuteAgentMemoryOperationProposalsResponseSchema,
  RetrieveAgentMemoryRequestSchema,
} from '@haohaoxue/lexora-contracts'
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common'
import { Public } from '../../decorators/public.decorator'
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe'
import { AgentMemoryOperationsService } from './agent-memory-operations.service'
import { AgentMemoryService } from './agent-memory.service'

@Controller('internal/agent/memory')
export class AgentMemoryInternalController {
  constructor(
    private readonly memories: AgentMemoryService,
    private readonly operations: AgentMemoryOperationsService,
  ) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('retrieve')
  retrieveMemories(
    @Body(new ZodValidationPipe(RetrieveAgentMemoryRequestSchema)) payload: RetrieveAgentMemoryRequest,
  ): Promise<RetrieveAgentMemoryResponse> {
    return this.memories.retrieveMemoriesForAgent(payload)
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('operations')
  async executeOperationProposals(
    @Body(new ZodValidationPipe(ExecuteAgentMemoryOperationProposalsRequestSchema)) payload: ExecuteAgentMemoryOperationProposalsRequest,
  ): Promise<ExecuteAgentMemoryOperationProposalsResponse> {
    const operations = await this.operations.processOperationProposals({
      userId: payload.actorUserId,
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      generationId: payload.generationId,
      agentProfileId: payload.agentProfileId,
      memoryWritingPolicy: payload.memoryWritingPolicy,
      operations: payload.operations,
    })

    return ExecuteAgentMemoryOperationProposalsResponseSchema.parse({ operations })
  }
}
