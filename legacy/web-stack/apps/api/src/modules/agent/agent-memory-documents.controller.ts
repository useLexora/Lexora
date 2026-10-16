import type {
  AgentMemoryDocument,
  AgentMemoryDocumentsResponse,
  GetAgentMemoryDocumentParams,
  ListAgentMemoryDocumentsQuery,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../auth/auth.interface'
import {
  GetAgentMemoryDocumentParamsSchema,
  ListAgentMemoryDocumentsQuerySchema,
} from '@haohaoxue/lexora-contracts'
import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe'
import { AgentMemoryDocumentsService } from './agent-memory-documents.service'

@Controller('users/me/agent/memory-documents')
export class AgentMemoryDocumentsController {
  constructor(private readonly documents: AgentMemoryDocumentsService) {}

  @Get()
  listDocuments(
    @CurrentUser() authUser: AuthUserContext,
    @Query(new ZodValidationPipe(ListAgentMemoryDocumentsQuerySchema)) query: ListAgentMemoryDocumentsQuery,
  ): Promise<AgentMemoryDocumentsResponse> {
    return this.documents.listDocuments(authUser.id, query)
  }

  @Get(':documentId')
  getDocument(
    @CurrentUser() authUser: AuthUserContext,
    @Param(new ZodValidationPipe(GetAgentMemoryDocumentParamsSchema)) params: GetAgentMemoryDocumentParams,
    @Query(new ZodValidationPipe(ListAgentMemoryDocumentsQuerySchema)) query: ListAgentMemoryDocumentsQuery,
  ): Promise<AgentMemoryDocument> {
    return this.documents.getDocument(authUser.id, params.documentId, query)
  }
}
