import type {
  CreatePlatformNotificationRequest,
  PlatformNotification,
  PlatformNotificationListResponse,
  UpdatePlatformNotificationRequest,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../auth/auth.interface'
import {
  CreatePlatformNotificationRequestSchema,
  PERMISSIONS,
  UpdatePlatformNotificationRequestSchema,
} from '@haohaoxue/lexora-contracts'
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { PageQuery } from '../../decorators/page-query.decorator'
import { RequirePermissions } from '../../decorators/require-permissions.decorator'
import { RequestPageParamsDto } from '../../dto/request-page-params.dto'
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe'
import { GetPlatformNotificationsQueryDto } from './notifications.dto'
import { NotificationsService } from './notifications.service'

@Controller('system-admin/notifications')
export class NotificationsAdminController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_READ)
  @Get()
  async listPlatformNotifications(
    @PageQuery() page: RequestPageParamsDto,
    @Query() query: GetPlatformNotificationsQueryDto,
  ): Promise<PlatformNotificationListResponse> {
    return this.notificationsService.listPlatformNotifications({
      ...page,
      ...query,
    })
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_UPDATE)
  @Post()
  async createPlatformNotification(
    @CurrentUser() authUser: AuthUserContext,
    @Body(new ZodValidationPipe(CreatePlatformNotificationRequestSchema)) payload: CreatePlatformNotificationRequest,
  ): Promise<PlatformNotification> {
    return this.notificationsService.createPlatformNotification(authUser.id, payload)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_UPDATE)
  @Patch(':id')
  async updatePlatformNotification(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') notificationId: string,
    @Body(new ZodValidationPipe(UpdatePlatformNotificationRequestSchema)) payload: UpdatePlatformNotificationRequest,
  ): Promise<PlatformNotification> {
    return this.notificationsService.updatePlatformNotification(authUser.id, notificationId, payload)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_NOTIFICATION_DELETE)
  @Delete(':id')
  async deletePlatformNotification(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') notificationId: string,
  ): Promise<void> {
    await this.notificationsService.deletePlatformNotification(authUser.id, notificationId)
  }
}
