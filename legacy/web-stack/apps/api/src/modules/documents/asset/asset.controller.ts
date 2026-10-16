import type {
  DocumentAsset,
  ResolveDocumentAssetsRequest,
  ResolveDocumentAssetsResponse,
} from '@haohaoxue/lexora-contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthUserContext } from '../../auth/auth.interface'
import { ResolveDocumentAssetsSchema } from '@haohaoxue/lexora-contracts'
import { FILE_SIZE_LIMITS } from '@haohaoxue/lexora-contracts/file'
import { BadRequestException, Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common'
import { CurrentUser } from '../../../decorators/current-user.decorator'
import { Public } from '../../../decorators/public.decorator'
import { ZodValidationPipe } from '../../../pipes/zod-validation.pipe'
import { getRequestFile, readRequestFileBuffer } from '../../../utils/request-file'
import { DOCUMENT_IMAGE_TOO_LARGE_MESSAGE } from './asset.constants'
import { DocumentAssetsService } from './asset.service'

@Controller('documents')
export class DocumentAssetController {
  constructor(private readonly documentAssetsService: DocumentAssetsService) {}

  @Post(':id/assets/images')
  async uploadDocumentImage(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<DocumentAsset> {
    const file = await getRequestFile(request, {
      maxBytes: FILE_SIZE_LIMITS.DOCUMENT_IMAGE,
    })

    if (!file) {
      throw new BadRequestException('请选择图片文件')
    }

    const asset = await this.documentAssetsService.uploadImage({
      actorId: authUser.id,
      documentId: id,
      fileName: file.filename,
      mimeType: file.mimetype,
      buffer: await readRequestFileBuffer(file, {
        fileTooLargeMessage: DOCUMENT_IMAGE_TOO_LARGE_MESSAGE,
      }),
    })
    response.header('set-cookie', await this.documentAssetsService.buildAssetAccessCookie({
      kind: 'document',
      documentId: id,
      actorId: authUser.id,
    }))
    return asset
  }

  @Post(':id/assets/files')
  async uploadDocumentFile(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<DocumentAsset> {
    const file = await getRequestFile(request)

    if (!file) {
      throw new BadRequestException('请选择附件文件')
    }

    const asset = await this.documentAssetsService.uploadFile({
      actorId: authUser.id,
      documentId: id,
      fileName: file.filename,
      mimeType: file.mimetype,
      buffer: await file.toBuffer(),
    })
    response.header('set-cookie', await this.documentAssetsService.buildAssetAccessCookie({
      kind: 'document',
      documentId: id,
      actorId: authUser.id,
    }))
    return asset
  }

  @Post(':id/assets/resolve')
  async resolveDocumentAssets(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ResolveDocumentAssetsSchema)) payload: ResolveDocumentAssetsRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<ResolveDocumentAssetsResponse> {
    const result = await this.documentAssetsService.resolveAssets({
      actorId: authUser.id,
      documentId: id,
      assetIds: payload.assetIds,
    })
    response.header('set-cookie', await this.documentAssetsService.buildAssetAccessCookie({
      kind: 'document',
      documentId: id,
      actorId: authUser.id,
    }))
    return result
  }

  @Public()
  @Get(':id/assets/:assetId/content')
  async getDocumentAssetContent(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply,
  ): Promise<FastifyReply> {
    const asset = await this.documentAssetsService.getAssetContent({
      documentId: id,
      assetId,
      cookieHeader: request.headers.cookie,
    })

    response.header('cache-control', 'private, max-age=300')
    response.header('content-type', asset.contentType)

    if (asset.contentLength !== null) {
      response.header('content-length', String(asset.contentLength))
    }

    return response.send(asset.body)
  }
}
