import type {
  PlatformNotificationAsset,
  ResolvePlatformNotificationAssetsRequest,
  ResolvePlatformNotificationAssetsResponse,
} from '@haohaoxue/lexora-contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthUserContext } from '../auth/auth.interface'
import {
  API_ERROR_CODE,
  PERMISSIONS,
  PLATFORM_NOTIFICATION_IMAGE_MAX_BYTES,
  ResolvePlatformNotificationAssetsSchema,
} from '@haohaoxue/lexora-contracts'
import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { Public } from '../../decorators/public.decorator'
import { RequirePermissions } from '../../decorators/require-permissions.decorator'
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe'
import { apiBadRequest } from '../../utils/api-error'
import { getRequestFile, readRequestFileBuffer } from '../../utils/request-file'
import { NotificationAssetsService } from './notification-assets.service'

const PLATFORM_NOTIFICATION_IMAGE_TOO_LARGE_MESSAGE = '图片大小不能超过 2MB'

@Controller('system-admin/notifications/assets')
export class NotificationAdminAssetsController {
  constructor(private readonly notificationAssetsService: NotificationAssetsService) {}

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_UPDATE)
  @Post('images')
  async uploadNotificationImage(
    @CurrentUser() authUser: AuthUserContext,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<PlatformNotificationAsset> {
    const file = await getRequestFile(request, {
      maxBytes: PLATFORM_NOTIFICATION_IMAGE_MAX_BYTES,
    })

    if (!file) {
      throw apiBadRequest(API_ERROR_CODE.NOTIFICATION_IMAGE_EMPTY)
    }

    const asset = await this.notificationAssetsService.uploadImage({
      actorId: authUser.id,
      fileName: file.filename,
      mimeType: file.mimetype,
      buffer: await readRequestFileBuffer(file, {
        fileTooLargeMessage: PLATFORM_NOTIFICATION_IMAGE_TOO_LARGE_MESSAGE,
      }),
    })
    response.header('set-cookie', await this.notificationAssetsService.buildAssetAccessCookie({
      kind: 'admin',
      actorId: authUser.id,
    }))
    return asset
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_READ)
  @Post('resolve')
  async resolveNotificationAssets(
    @CurrentUser() authUser: AuthUserContext,
    @Body(new ZodValidationPipe(ResolvePlatformNotificationAssetsSchema)) payload: ResolvePlatformNotificationAssetsRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<ResolvePlatformNotificationAssetsResponse> {
    const result = await this.notificationAssetsService.resolveAdminAssets(payload.assetIds)
    response.header('set-cookie', await this.notificationAssetsService.buildAssetAccessCookie({
      kind: 'admin',
      actorId: authUser.id,
    }))
    return result
  }
}

@Controller('notifications/assets')
export class NotificationAssetsController {
  constructor(private readonly notificationAssetsService: NotificationAssetsService) {}

  @RequirePermissions(PERMISSIONS.USER_READ_SELF)
  @Post('resolve')
  async resolvePublishedNotificationAssets(
    @CurrentUser() authUser: AuthUserContext,
    @Body(new ZodValidationPipe(ResolvePlatformNotificationAssetsSchema)) payload: ResolvePlatformNotificationAssetsRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<ResolvePlatformNotificationAssetsResponse> {
    const result = await this.notificationAssetsService.resolvePublishedAssets({
      assetIds: payload.assetIds,
    })
    response.header('set-cookie', await this.notificationAssetsService.buildAssetAccessCookie({
      kind: 'published',
      actorId: authUser.id,
    }))
    return result
  }

  @Public()
  @Get(':assetId/content')
  async getNotificationAssetContent(
    @Param('assetId') assetId: string,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply,
  ): Promise<FastifyReply> {
    const asset = await this.notificationAssetsService.getAssetContent({
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
