import type {
  BatchDeleteChatSessionsRequest,
  BatchDeleteChatSessionsResponse,
  ChatModelListResponse,
  ChatMutationResponse,
  ChatRuntimeConfig,
  ChatSessionDetail,
  ChatSessionEvent,
  ChatSessionOrigin,
  ChatSessionSummary,
  CreateChatSessionMessageRequest,
  CreateChatSessionRequest,
  EditAndSendChatMessageRequest,
  GetChatSessionsQuery,
  ResumeChatRunRequest,
  RetryChatAssistantMessageRequest,
} from '@haohaoxue/lexora-contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthUserContext } from '../auth/auth.interface'
import {
  BatchDeleteChatSessionsRequestSchema,
  CHAT_SESSION_ORIGIN,
  ChatSessionOriginSchema,
  CreateChatSessionMessageRequestSchema,
  CreateChatSessionRequestSchema,
  EditAndSendChatMessageRequestSchema,
  GetChatSessionsQuerySchema,
  ResumeChatRunRequestSchema,
  RetryChatAssistantMessageRequestSchema,
} from '@haohaoxue/lexora-contracts'
import { sleep } from '@haohaoxue/lexora-shared'
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe'
import { ChatSessionEventsService } from './chat-session-events.service'
import { ChatSessionsService } from './chat-sessions.service'
import {
  SwitchChatActiveMessageRequestDto,
  UpdateChatSessionModelRequestDto,
  UpdateChatSessionTitleRequestDto,
} from './chat.dto'
import { ChatService } from './chat.service'

const SESSION_EVENT_POLL_INTERVAL_MS = 1000
const SESSION_EVENT_HEARTBEAT_INTERVAL_MS = 15_000
const SESSION_EVENT_INITIAL_PADDING = ' '.repeat(2048)

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatSessionsService: ChatSessionsService,
    private readonly chatSessionEvents: ChatSessionEventsService,
  ) {}

  @Get('sessions')
  async getSessions(
    @CurrentUser() authUser: AuthUserContext,
    @Query(new ZodValidationPipe(GetChatSessionsQuerySchema)) query: GetChatSessionsQuery,
  ): Promise<ChatSessionSummary[]> {
    return this.chatSessionsService.getSessions(
      authUser.id,
      query.workspaceId,
      query.origin ?? CHAT_SESSION_ORIGIN.GLOBAL,
    )
  }

  @Post('sessions')
  async createSession(
    @CurrentUser() authUser: AuthUserContext,
    @Body(new ZodValidationPipe(CreateChatSessionRequestSchema)) payload: CreateChatSessionRequest,
  ): Promise<ChatSessionDetail> {
    return this.chatSessionsService.createSession(
      authUser.id,
      payload.workspaceId,
      payload.origin ?? CHAT_SESSION_ORIGIN.GLOBAL,
    )
  }

  @Get('sessions/:id')
  async getSession(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') sessionId: string,
    @Query('origin') origin: string | undefined,
  ): Promise<ChatSessionDetail> {
    return this.chatSessionsService.getSession(authUser.id, sessionId, parseChatSessionOrigin(origin))
  }

  @Delete('sessions/:id')
  async deleteSession(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') sessionId: string,
    @Query('origin') origin: string | undefined,
  ): Promise<null> {
    await this.chatService.deleteSession({
      userId: authUser.id,
      sessionId,
      origin: parseChatSessionOrigin(origin),
    })
    return null
  }

  @Post('sessions/batch-delete')
  async batchDeleteSessions(
    @CurrentUser() authUser: AuthUserContext,
    @Body(new ZodValidationPipe(BatchDeleteChatSessionsRequestSchema)) payload: BatchDeleteChatSessionsRequest,
    @Query('origin') origin: string | undefined,
  ): Promise<BatchDeleteChatSessionsResponse> {
    return this.chatService.batchDeleteSessions({
      userId: authUser.id,
      sessionIds: payload.sessionIds,
      origin: parseChatSessionOrigin(origin),
    })
  }

  @Patch('sessions/:id/model')
  async updateSessionModel(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') sessionId: string,
    @Query('origin') origin: string | undefined,
    @Body() payload: UpdateChatSessionModelRequestDto,
  ): Promise<ChatSessionDetail> {
    return this.chatService.updateSessionModel({
      userId: authUser.id,
      sessionId,
      origin: parseChatSessionOrigin(origin),
      modelRef: payload.modelRef ?? null,
    })
  }

  @Patch('sessions/:id/title')
  async updateSessionTitle(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') sessionId: string,
    @Query('origin') origin: string | undefined,
    @Body() payload: UpdateChatSessionTitleRequestDto,
  ): Promise<ChatSessionDetail> {
    return this.chatSessionsService.updateSessionTitle({
      userId: authUser.id,
      sessionId,
      origin: parseChatSessionOrigin(origin),
      title: payload.title,
    })
  }

  @Post('sessions/:id/messages')
  async sendMessage(
    @CurrentUser() authUser: AuthUserContext,
    @Req() request: FastifyRequest,
    @Param('id') sessionId: string,
    @Query('origin') origin: string | undefined,
    @Body(new ZodValidationPipe(CreateChatSessionMessageRequestSchema)) payload: CreateChatSessionMessageRequest,
  ): Promise<ChatMutationResponse> {
    return this.chatService.sendMessage({
      userId: authUser.id,
      sessionId,
      origin: parseChatSessionOrigin(origin),
      content: payload.content,
      contentJSON: payload.contentJSON,
      attachments: payload.attachments,
      memory: payload.memory,
      skillInvocation: payload.skillInvocation,
      disabledSkillKeys: payload.disabledSkillKeys,
      runtimeHints: payload.runtimeHints,
      request,
    })
  }

  @Post('sessions/:id/messages/:messageId/edit-and-send')
  async editAndSendMessage(
    @CurrentUser() authUser: AuthUserContext,
    @Req() request: FastifyRequest,
    @Param('id') sessionId: string,
    @Param('messageId') messageId: string,
    @Query('origin') origin: string | undefined,
    @Body(new ZodValidationPipe(EditAndSendChatMessageRequestSchema)) payload: EditAndSendChatMessageRequest,
  ): Promise<ChatMutationResponse> {
    return this.chatService.editAndSendMessage({
      userId: authUser.id,
      sessionId,
      messageId,
      origin: parseChatSessionOrigin(origin),
      content: payload.content,
      contentJSON: payload.contentJSON,
      attachments: payload.attachments,
      memory: payload.memory,
      skillInvocation: payload.skillInvocation,
      disabledSkillKeys: payload.disabledSkillKeys,
      runtimeHints: payload.runtimeHints,
      request,
    })
  }

  @Post('sessions/:id/messages/:messageId/retry')
  async retryAssistantMessage(
    @CurrentUser() authUser: AuthUserContext,
    @Req() request: FastifyRequest,
    @Param('id') sessionId: string,
    @Param('messageId') messageId: string,
    @Query('origin') origin: string | undefined,
    @Body(new ZodValidationPipe(RetryChatAssistantMessageRequestSchema)) payload: RetryChatAssistantMessageRequest,
  ): Promise<ChatMutationResponse> {
    return this.chatService.retryAssistantMessage({
      userId: authUser.id,
      sessionId,
      messageId,
      origin: parseChatSessionOrigin(origin),
      runtimeHints: payload.runtimeHints,
      request,
    })
  }

  @Patch('sessions/:id/active-message')
  async switchActiveMessage(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') sessionId: string,
    @Query('origin') origin: string | undefined,
    @Body() payload: SwitchChatActiveMessageRequestDto,
  ): Promise<ChatMutationResponse> {
    return this.chatService.switchActiveMessage({
      userId: authUser.id,
      sessionId,
      messageId: payload.messageId,
      origin: parseChatSessionOrigin(origin),
    })
  }

  @Post('runs/:runId/cancel')
  async cancelRun(
    @CurrentUser() authUser: AuthUserContext,
    @Param('runId') runId: string,
    @Query('origin') origin: string | undefined,
  ): Promise<ChatMutationResponse> {
    return this.chatService.cancelRun({
      userId: authUser.id,
      runId,
      origin: parseChatSessionOrigin(origin),
    })
  }

  @Post('runs/:runId/resume')
  async resumeRun(
    @CurrentUser() authUser: AuthUserContext,
    @Param('runId') runId: string,
    @Query('origin') origin: string | undefined,
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(ResumeChatRunRequestSchema)) payload: ResumeChatRunRequest,
  ): Promise<ChatMutationResponse> {
    return this.chatService.resumeRun({
      userId: authUser.id,
      runId,
      origin: parseChatSessionOrigin(origin),
      request,
      resume: payload.resume,
    })
  }

  @Get('sessions/:id/events')
  async streamSessionEvents(
    @CurrentUser() authUser: AuthUserContext,
    @Param('id') sessionId: string,
    @Query('afterSequence') afterSequence: string | undefined,
    @Query('origin') origin: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.chatSessionsService.getSession(authUser.id, sessionId, parseChatSessionOrigin(origin))

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.flushHeaders?.()
    writeSessionComment(reply, `connected ${SESSION_EVENT_INITIAL_PADDING}`)

    let cursor = parseAfterSequence(afterSequence)
    const minimumSequence = await this.chatSessionEvents.getMinimumSequence(sessionId)
    const latestSequence = await this.chatSessionEvents.getLatestSequence(sessionId)
    let lastHeartbeatAt = Date.now()

    if (cursor === null || (minimumSequence !== null && cursor < minimumSequence - 1)) {
      writeSessionEvent(reply, this.chatSessionEvents.createSnapshotRequiredEvent({
        sessionId,
        latestSequence,
      }))
      cursor = latestSequence
      lastHeartbeatAt = Date.now()
    }

    try {
      while (isReplyWritable(reply)) {
        const events = await this.chatSessionEvents.getEventsAfter(sessionId, cursor)

        for (const event of events) {
          if (!isReplyWritable(reply)) {
            return
          }

          writeSessionEvent(reply, event)
          cursor = event.sequence
          lastHeartbeatAt = Date.now()
        }

        if (Date.now() - lastHeartbeatAt >= SESSION_EVENT_HEARTBEAT_INTERVAL_MS && isReplyWritable(reply)) {
          writeSessionComment(reply, 'heartbeat')
          lastHeartbeatAt = Date.now()
        }

        await sleep(SESSION_EVENT_POLL_INTERVAL_MS)
      }
    }
    finally {
      if (isReplyWritable(reply)) {
        reply.raw.end()
      }
    }
  }

  @Get('config')
  async getRuntimeConfig(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<ChatRuntimeConfig> {
    return this.chatService.getRuntimeConfig(authUser.id)
  }

  @Get('models')
  async getModels(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<ChatModelListResponse> {
    return {
      models: await this.chatService.getModels(authUser.id),
    }
  }
}

function parseAfterSequence(value: string | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  const sequence = Number(value)
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : null
}

function parseChatSessionOrigin(value: string | undefined): ChatSessionOrigin {
  const parsed = ChatSessionOriginSchema.optional().safeParse(value)
  if (!parsed.success) {
    throw new BadRequestException('origin 参数无效')
  }

  return parsed.data ?? CHAT_SESSION_ORIGIN.GLOBAL
}

function writeSessionEvent(reply: FastifyReply, event: ChatSessionEvent): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
}

function writeSessionComment(reply: FastifyReply, value: string): void {
  reply.raw.write(`: ${value}\n\n`)
}

function isReplyWritable(reply: FastifyReply): boolean {
  return !reply.raw.destroyed && !reply.raw.writableEnded
}
