import type {
  CreateDocumentVersionSnapshotRequest,
  CreateDocumentVersionSnapshotResponse,
  DocumentCurrent,
  DocumentHistory,
  DocumentVersionSnapshot,
  RestoreDocumentVersionSnapshotRequest,
  RestoreDocumentVersionSnapshotResponse,
  SaveDocumentContentRequest,
  SaveDocumentContentResponse,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../../auth/auth.interface'
import {
  CreateDocumentVersionSnapshotSchema,
  RestoreDocumentVersionSnapshotSchema,
  SaveDocumentContentSchema,
} from '@haohaoxue/lexora-contracts'
import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common'
import { CurrentUser } from '../../../decorators/current-user.decorator'
import { ZodValidationPipe } from '../../../pipes/zod-validation.pipe'
import { DocumentContentService } from './content.service'

@Controller('documents')
export class DocumentContentController {
  constructor(private readonly documentContentService: DocumentContentService) {}

  @Get(':id')
  async getDocumentCurrent(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
  ): Promise<DocumentCurrent> {
    return this.documentContentService.getDocumentCurrent(authUser.id, id)
  }

  @Put(':id/content')
  async saveDocumentContent(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SaveDocumentContentSchema)) payload: SaveDocumentContentRequest,
  ): Promise<SaveDocumentContentResponse> {
    return this.documentContentService.saveDocumentContent(authUser.id, id, payload)
  }

  @Post(':id/version-snapshots')
  async createDocumentVersionSnapshot(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateDocumentVersionSnapshotSchema)) payload: CreateDocumentVersionSnapshotRequest,
  ): Promise<CreateDocumentVersionSnapshotResponse> {
    return this.documentContentService.createDocumentVersionSnapshot(authUser.id, id, payload)
  }

  @Get(':id/version-snapshots')
  async getDocumentVersionSnapshots(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
  ): Promise<DocumentVersionSnapshot[]> {
    return this.documentContentService.getDocumentVersionSnapshots(authUser.id, id)
  }

  @Get(':id/history')
  async getDocumentHistory(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
  ): Promise<DocumentHistory> {
    return this.documentContentService.getDocumentHistory(authUser.id, id)
  }

  @Post(':id/restore-version')
  async restoreDocumentVersionSnapshot(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RestoreDocumentVersionSnapshotSchema)) payload: RestoreDocumentVersionSnapshotRequest,
  ): Promise<RestoreDocumentVersionSnapshotResponse> {
    return this.documentContentService.restoreDocumentVersionSnapshot(authUser.id, id, payload)
  }
}
