import type { RequestPageParams } from '@haohaoxue/lexora-contracts'
import { Type } from 'class-transformer'
import {
  IsInt,
  Max,
  Min,
} from 'class-validator'

export class RequestPageParamsDto implements RequestPageParams {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageNo = 1

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20
}
