import type {
  NotificationListResponse,
  NotificationMarkAllReadResponse,
  NotificationSummary,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../auth/auth.interface'
import { PERMISSIONS } from '@haohaoxue/lexora-contracts'
import {
  Controller,
  Get,
  Patch,
  Query,
} from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { RequirePermissions } from '../../decorators/require-permissions.decorator'
import { GetNotificationsQueryDto } from './notifications.dto'
import { NotificationsService } from './notifications.service'

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @RequirePermissions(PERMISSIONS.USER_READ_SELF)
  @Get()
  async listNotifications(
    @CurrentUser() authUser: AuthUserContext,
    @Query() query: GetNotificationsQueryDto,
  ): Promise<NotificationListResponse> {
    return this.notificationsService.listNotifications(authUser.id, query)
  }

  @RequirePermissions(PERMISSIONS.USER_READ_SELF)
  @Get('summary')
  async getNotificationSummary(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<NotificationSummary> {
    return this.notificationsService.getNotificationSummary(authUser.id)
  }

  @RequirePermissions(PERMISSIONS.USER_UPDATE_SELF)
  @Patch('read-all')
  async markAllAsRead(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<NotificationMarkAllReadResponse> {
    return this.notificationsService.markAllAsRead(authUser.id)
  }
}
