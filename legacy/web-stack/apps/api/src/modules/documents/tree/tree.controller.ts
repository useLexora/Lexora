import type {
  CreateDocumentRequest,
  CreateDocumentResponse,
  DocumentCurrent,
  DocumentTreeGroup,
  PatchDocumentLayoutRequest,
  PatchDocumentMetaRequest,
  SearchReadableDocumentsQuery,
  SearchReadableDocumentsResponse,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../../auth/auth.interface'
import {
  CreateDocumentSchema,
  PatchDocumentLayoutSchema,
  PatchDocumentMetaSchema,
  SearchReadableDocumentsQuerySchema,
} from '@haohaoxue/lexora-contracts'
import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { CurrentUser } from '../../../decorators/current-user.decorator'
import { ZodValidationPipe } from '../../../pipes/zod-validation.pipe'
import { DocumentsService } from './tree.service'

@Controller('documents')
export class DocumentTreeController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  async createDocument(
    @CurrentUser() authUser: AuthUserContext,
    @Body(new ZodValidationPipe(CreateDocumentSchema)) payload: CreateDocumentRequest,
  ): Promise<CreateDocumentResponse> {
    return this.documentsService.createDocument(authUser.id, payload)
  }

  @Get()
  async getDocumentTree(
    @CurrentUser() authUser: AuthUserContext,
    @Query('workspaceId') workspaceId: string,
  ): Promise<DocumentTreeGroup[]> {
    if (!workspaceId?.trim()) {
      throw new BadRequestException('缺少 workspaceId')
    }

    return this.documentsService.getDocumentTree(authUser.id, workspaceId.trim())
  }

  @Get('search')
  async searchReadableDocumentsForChat(
    @CurrentUser() authUser: AuthUserContext,
    @Query(new ZodValidationPipe(SearchReadableDocumentsQuerySchema)) query: SearchReadableDocumentsQuery,
  ): Promise<SearchReadableDocumentsResponse> {
    return this.documentsService.searchReadableDocumentsForChat(authUser.id, query)
  }

  @Patch(':id/meta')
  async patchDocumentMeta(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PatchDocumentMetaSchema)) payload: PatchDocumentMetaRequest,
  ): Promise<DocumentCurrent> {
    return this.documentsService.patchDocumentMeta(authUser.id, id, payload)
  }

  @Patch(':id/layout')
  async patchDocumentLayout(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PatchDocumentLayoutSchema)) payload: PatchDocumentLayoutRequest,
  ): Promise<DocumentCurrent> {
    return this.documentsService.patchDocumentLayout(authUser.id, id, payload)
  }
}
