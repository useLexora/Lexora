import type {
  SystemEmailProvider,
  TestSystemEmailConfigRequest,
  UpdateSystemEmailConfigRequest,
  UpdateSystemEmailServiceStatusRequest,
} from '@haohaoxue/lexora-contracts'
import { SYSTEM_EMAIL_PROVIDER_VALUES } from '@haohaoxue/lexora-contracts'
import { Transform } from 'class-transformer'
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator'

export class UpdateSystemEmailConfigDto implements UpdateSystemEmailConfigRequest {
  @IsIn(SYSTEM_EMAIL_PROVIDER_VALUES)
  provider!: SystemEmailProvider

  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  smtpHost!: string

  @Min(1)
  smtpPort!: number

  @IsBoolean()
  smtpSecure!: boolean

  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  smtpUsername!: string

  @IsOptional()
  @IsString()
  @MaxLength(256)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  smtpPassword?: string

  @IsOptional()
  @IsBoolean()
  clearPassword?: boolean

  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  fromName!: string

  @IsEmail({}, { message: '请输入有效的发件邮箱' })
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  fromEmail!: string
}

export class UpdateSystemEmailServiceStatusDto implements UpdateSystemEmailServiceStatusRequest {
  @IsBoolean()
  enabled!: boolean
}

export class TestSystemEmailConfigDto implements TestSystemEmailConfigRequest {
  @IsEmail({}, { message: '请输入有效的收件邮箱' })
  @MaxLength(120)
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  email!: string
}
