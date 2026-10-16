import type { ChatAssetUploadQuery, ChatUploadedAsset } from '@haohaoxue/lexora-contracts'
import type { FastifyRequest } from 'fastify'
import type { AuthUserContext } from '../auth/auth.interface'
import { ChatAssetUploadQuerySchema } from '@haohaoxue/lexora-contracts'
import { BadRequestException, Controller, Post, Query, Req } from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe'
import { getRequestFile, readRequestFileBuffer } from '../../utils/request-file'
import { ChatAssetsService, getChatAttachmentMaxBytes } from './chat-assets.service'

@Controller('chat/assets')
export class ChatAssetsController {
  constructor(private readonly chatAssetsService: ChatAssetsService) {}

  @Post('images')
  async uploadImage(
    @CurrentUser() authUser: AuthUserContext,
    @Query(new ZodValidationPipe(ChatAssetUploadQuerySchema)) query: ChatAssetUploadQuery,
    @Req() request: FastifyRequest,
  ): Promise<ChatUploadedAsset> {
    const file = await getRequestFile(request, {
      maxBytes: getChatAttachmentMaxBytes('image'),
    })

    if (!file) {
      throw new BadRequestException('请选择图片文件')
    }

    return this.chatAssetsService.uploadImage({
      actorId: authUser.id,
      workspaceId: query.workspaceId,
      fileName: file.filename,
      mimeType: file.mimetype,
      buffer: await readRequestFileBuffer(file, {
        fileTooLargeMessage: '图片大小超过限制',
      }),
    })
  }

  @Post('files')
  async uploadFile(
    @CurrentUser() authUser: AuthUserContext,
    @Query(new ZodValidationPipe(ChatAssetUploadQuerySchema)) query: ChatAssetUploadQuery,
    @Req() request: FastifyRequest,
  ): Promise<ChatUploadedAsset> {
    const file = await getRequestFile(request, {
      maxBytes: getChatAttachmentMaxBytes('file'),
    })

    if (!file) {
      throw new BadRequestException('请选择附件文件')
    }

    return this.chatAssetsService.uploadFile({
      actorId: authUser.id,
      workspaceId: query.workspaceId,
      fileName: file.filename,
      mimeType: file.mimetype,
      buffer: await readRequestFileBuffer(file, {
        fileTooLargeMessage: '文件大小超过限制',
      }),
    })
  }
}
