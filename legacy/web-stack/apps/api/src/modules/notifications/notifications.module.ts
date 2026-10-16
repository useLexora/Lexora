import { Module } from '@nestjs/common'
import { StorageModule } from '../../infrastructure/storage/storage.module'
import { NotificationAdminAssetsController, NotificationAssetsController } from './notification-assets.controller'
import { NotificationAssetsService } from './notification-assets.service'
import { NotificationsAdminController } from './notifications-admin.controller'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'

@Module({
  imports: [StorageModule],
  controllers: [
    NotificationsController,
    NotificationsAdminController,
    NotificationAssetsController,
    NotificationAdminAssetsController,
  ],
  providers: [NotificationsService, NotificationAssetsService],
})
export class NotificationsModule {}
