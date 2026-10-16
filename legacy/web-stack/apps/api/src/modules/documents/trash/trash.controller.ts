import type {
  BatchDeleteDocumentsRequest,
  BatchDeleteDocumentsResponse,
  DocumentTrashItem,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../../auth/auth.interface'
import { BatchDeleteDocumentsRequestSchema } from '@haohaoxue/lexora-contracts'
import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common'
import { CurrentUser } from '../../../decorators/current-user.decorator'
import { ZodValidationPipe } from '../../../pipes/zod-validation.pipe'
import { DocumentTrashService } from './trash.service'

@Controller('documents')
export class DocumentTrashController {
  constructor(private readonly documentTrashService: DocumentTrashService) {}

  @Get('trash')
  async getTrashDocuments(
    @CurrentUser() authUser: AuthUserContext,
    @Query('workspaceId') workspaceId: string,
  ): Promise<DocumentTrashItem[]> {
    if (!workspaceId?.trim()) {
      throw new BadRequestException('缺少 workspaceId')
    }

    return this.documentTrashService.getTrashDocuments(authUser.id, workspaceId.trim())
  }

  @Delete(':id')
  async deleteDocument(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
  ): Promise<null> {
    await this.documentTrashService.deleteDocument(authUser.id, id)
    return null
  }

  @Post('batch-delete')
  async batchDeleteDocuments(
    @CurrentUser() authUser: AuthUserContext,
    @Body(new ZodValidationPipe(BatchDeleteDocumentsRequestSchema)) payload: BatchDeleteDocumentsRequest,
  ): Promise<BatchDeleteDocumentsResponse> {
    return {
      deletedDocumentIds: await this.documentTrashService.batchDeleteDocuments(authUser.id, payload.workspaceId, payload.documentIds),
    }
  }

  @Post(':id/restore-from-trash')
  async restoreDocumentFromTrash(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
  ): Promise<null> {
    await this.documentTrashService.restoreDocumentFromTrash(authUser.id, id)
    return null
  }

  @Delete(':id/permanent')
  async permanentlyDeleteDocument(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
  ): Promise<null> {
    await this.documentTrashService.permanentlyDeleteDocument(authUser.id, id)
    return null
  }
}
