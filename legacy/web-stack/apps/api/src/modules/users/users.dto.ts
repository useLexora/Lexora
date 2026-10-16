import type {
  AppearancePreference,
  ConfirmBindEmailRequest,
  DeleteCurrentUserRequest as DeleteCurrentUserPayload,
  LanguagePreference,
  RequestBindEmailCodeRequest,
  StartOauthBindingRequest,
  UpdateCurrentUserProfileRequest,
  UpdateUserPreferencesRequest,
} from '@haohaoxue/lexora-contracts'
import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  APPEARANCE_PREFERENCE_VALUES,
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PASSWORD_REQUIRED_PATTERN,
  LANGUAGE_PREFERENCE_VALUES,
} from '@haohaoxue/lexora-contracts'
import {
  Equals,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator'

export class UpdateCurrentUserProfileDto implements UpdateCurrentUserProfileRequest {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  displayName!: string
}

export class RequestBindEmailCodeDto implements RequestBindEmailCodeRequest {
  @IsEmail()
  email!: string
}

export class ConfirmBindEmailDto implements ConfirmBindEmailRequest {
  @IsEmail()
  email!: string

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string

  @IsOptional()
  @IsString()
  @MinLength(AUTH_PASSWORD_MIN_LENGTH)
  @MaxLength(AUTH_PASSWORD_MAX_LENGTH)
  @Matches(AUTH_PASSWORD_REQUIRED_PATTERN)
  newPassword?: string
}

export class DeleteCurrentUserDto implements DeleteCurrentUserPayload {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  accountConfirmation!: string

  @IsString()
  @Equals(ACCOUNT_DELETION_CONFIRMATION_PHRASE)
  confirmationPhrase!: DeleteCurrentUserPayload['confirmationPhrase']
}

export class StartOauthBindingDto implements StartOauthBindingRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  @Matches(/^\/(?!\/)/)
  redirectPath!: string
}

export class UpdateUserPreferencesDto implements UpdateUserPreferencesRequest {
  @IsOptional()
  @IsIn(LANGUAGE_PREFERENCE_VALUES)
  language?: LanguagePreference

  @IsOptional()
  @IsIn(APPEARANCE_PREFERENCE_VALUES)
  appearance?: AppearancePreference
}
