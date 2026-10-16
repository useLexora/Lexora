import type {
  CreateChatSessionMessageRequest,
  CreateChatSessionRequest,
  EditAndSendChatMessageRequest,
  SwitchChatActiveMessageRequest,
  UpdateChatSessionModelRequest,
  UpdateChatSessionTitleRequest,
} from '@haohaoxue/lexora-contracts'
import {
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
  CHAT_SESSION_ORIGIN_VALUES,
  CHAT_SESSION_TITLE_MAX_LENGTH,
} from '@haohaoxue/lexora-contracts'
import { Transform, Type } from 'class-transformer'
import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator'

class ChatModelRefDto {
  @IsString()
  providerId!: string

  @IsString()
  modelId!: string
}

export class CreateChatSessionRequestDto implements CreateChatSessionRequest {
  @IsString()
  @MinLength(1)
  workspaceId!: string

  @IsOptional()
  @IsIn(CHAT_SESSION_ORIGIN_VALUES)
  origin?: CreateChatSessionRequest['origin']
}

export class CreateChatSessionMessageRequestDto implements CreateChatSessionMessageRequest {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_MESSAGE_CONTENT_MAX_LENGTH)
  content!: string

  @IsObject()
  contentJSON!: CreateChatSessionMessageRequest['contentJSON']

  @IsOptional()
  @IsArray()
  attachments?: CreateChatSessionMessageRequest['attachments']

  @IsOptional()
  @IsObject()
  memory!: CreateChatSessionMessageRequest['memory']

  @IsOptional()
  @IsObject()
  skillInvocation!: CreateChatSessionMessageRequest['skillInvocation']

  @IsOptional()
  @IsArray()
  disabledSkillKeys!: CreateChatSessionMessageRequest['disabledSkillKeys']
}

export class EditAndSendChatMessageRequestDto implements EditAndSendChatMessageRequest {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_MESSAGE_CONTENT_MAX_LENGTH)
  content!: string

  @IsObject()
  contentJSON!: EditAndSendChatMessageRequest['contentJSON']

  @IsOptional()
  @IsArray()
  attachments?: EditAndSendChatMessageRequest['attachments']

  @IsOptional()
  @IsObject()
  memory!: EditAndSendChatMessageRequest['memory']

  @IsOptional()
  @IsObject()
  skillInvocation!: EditAndSendChatMessageRequest['skillInvocation']

  @IsOptional()
  @IsArray()
  disabledSkillKeys!: EditAndSendChatMessageRequest['disabledSkillKeys']
}

export class SwitchChatActiveMessageRequestDto implements SwitchChatActiveMessageRequest {
  @IsString()
  @MinLength(1)
  messageId!: string
}

export class UpdateChatSessionModelRequestDto implements UpdateChatSessionModelRequest {
  @IsOptional()
  @Type(() => ChatModelRefDto)
  @ValidateNested()
  modelRef!: ChatModelRefDto | null
}

export class UpdateChatSessionTitleRequestDto implements UpdateChatSessionTitleRequest {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_SESSION_TITLE_MAX_LENGTH)
  title!: string
}
