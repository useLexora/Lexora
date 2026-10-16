import type {
  CreateDocumentDuplicateOperationResponse,
  CreateDocumentMoveOperationResponse,
  DocumentOperationJob,
  MoveDocumentTreeOperationRequest,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../../auth/auth.interface'
import { MoveDocumentTreeOperationSchema } from '@haohaoxue/lexora-contracts'
import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { CurrentUser } from '../../../decorators/current-user.decorator'
import { ZodValidationPipe } from '../../../pipes/zod-validation.pipe'
import { DocumentOperationsService } from './operations.service'

@Controller()
export class DocumentOperationsController {
  constructor(private readonly documentOperationsService: DocumentOperationsService) {}

  @Post('documents/:id/operation-jobs/duplicate')
  async createDuplicateDocumentTreeJob(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
  ): Promise<CreateDocumentDuplicateOperationResponse> {
    return {
      job: await this.documentOperationsService.createDuplicateDocumentTreeJob(authUser.id, id),
    }
  }

  @Post('documents/:id/operation-jobs/move')
  async createMoveDocumentTreeJob(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(MoveDocumentTreeOperationSchema)) payload: MoveDocumentTreeOperationRequest,
  ): Promise<CreateDocumentMoveOperationResponse> {
    return {
      job: await this.documentOperationsService.createMoveDocumentTreeJob(authUser.id, id, payload),
    }
  }

  @Get('document-operation-jobs/:id')
  async getOperationJob(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
  ): Promise<DocumentOperationJob> {
    return this.documentOperationsService.getOperationJob(authUser.id, id)
  }
}
