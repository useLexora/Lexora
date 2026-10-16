import type {
  GetPlatformNotificationsQuery,
  NotificationListFilter,
  NotificationListQuery,
  PlatformNotificationStatus,
} from '@haohaoxue/lexora-contracts'
import {
  NOTIFICATION_LIST_FILTER,
  NOTIFICATION_LIST_FILTER_VALUES,
  PLATFORM_NOTIFICATION_STATUS_VALUES,
} from '@haohaoxue/lexora-contracts'
import { Type } from 'class-transformer'
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator'
import { RequestPageParamsDto } from '../../dto/request-page-params.dto'

export class GetNotificationsQueryDto implements NotificationListQuery {
  @IsOptional()
  @IsIn(NOTIFICATION_LIST_FILTER_VALUES)
  filter: NotificationListFilter = NOTIFICATION_LIST_FILTER.ALL

  @IsOptional()
  @IsString()
  cursor?: string

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20
}

export class GetPlatformNotificationsQueryDto extends RequestPageParamsDto implements GetPlatformNotificationsQuery {
  @IsOptional()
  @IsIn(PLATFORM_NOTIFICATION_STATUS_VALUES)
  status?: PlatformNotificationStatus
}
