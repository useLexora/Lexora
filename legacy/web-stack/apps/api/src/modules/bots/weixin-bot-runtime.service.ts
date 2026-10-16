import type { BotRuntimeState } from '@haohaoxue/lexora-contracts'
import type { Prisma } from '@prisma/client'
import type { WeixinMessage, WeixinRuntimeAccount } from './bots.interface'
import {
  BOT_RUNTIME_STATE,
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
  CHAT_SESSION_CHANNEL,
  CHAT_SESSION_ORIGIN,
} from '@haohaoxue/lexora-contracts'
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import {
  BotAccountChannel,
  BotAccountStatus,
  ChatSessionMessageStatus,
  Prisma as PrismaNamespace,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { ChatSessionsService } from '../chat/chat-sessions.service'
import { ChatService } from '../chat/chat.service'
import { PersonalWorkspacesService } from '../workspaces/personal-workspaces.service'
import { BotCredentialsService } from './bot-credentials.service'
import {
  WEIXIN_LONG_POLL_TIMEOUT_MS,
} from './bots.interface'
import {
  createWeixinMessageKey,
  extractWeixinMessageText,
  formatWeixinPeerTitle,
  shouldHandleWeixinMessage,
  toPlainTextContentJSON,
} from './bots.utils'
import { WeixinOpenClawApiService } from './weixin-openclaw-api.service'

interface RuntimeStatus {
  state: BotRuntimeState
  lastError?: string | null
  lastLog?: string | null
  startedAt?: Date | null
  stoppedAt?: Date | null
}

interface RuntimeEntry {
  abortController: AbortController
  preserveDesiredStateOnStop: boolean
  promise: Promise<void>
  status: RuntimeStatus
}

const SESSION_EXPIRED_ERRCODE = -14
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000
const MAX_CONSECUTIVE_FAILURES = 3
const BOT_REPLY_TIMEOUT_MS = 240_000
const BOT_REPLY_POLL_INTERVAL_MS = 1000
const WEIXIN_AGENT_ERROR_REPLY = '抱歉，刚才处理你的消息时出现了点问题，请稍后再发一次试试。'
const WEIXIN_UNSUPPORTED_MESSAGE_REPLY = '暂时只能处理文字消息和已转文字的语音消息。'

@Injectable()
export class WeixinBotRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WeixinBotRuntimeService.name)
  private readonly runtimes = new Map<string, RuntimeEntry>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: BotCredentialsService,
    private readonly weixinApi: WeixinOpenClawApiService,
    private readonly chatService: ChatService,
    private readonly chatSessions: ChatSessionsService,
    private readonly personalWorkspaces: PersonalWorkspacesService,
  ) {}

  onModuleInit(): void {
    void this.startConnectedAccounts().catch(error => this.logger.error(
      error instanceof Error ? error.message : 'start weixin bot accounts failed',
      error instanceof Error ? error.stack : undefined,
    ))
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map(accountId =>
      this.stopAccount(accountId, { persistDesiredState: false }),
    ))
  }

  getStatus(accountId: string): RuntimeStatus {
    return this.runtimes.get(accountId)?.status ?? {
      state: BOT_RUNTIME_STATE.NOT_BOUND,
    }
  }

  async startAccount(accountId: string): Promise<void> {
    const current = this.runtimes.get(accountId)
    if (current && (
      current.status.state === BOT_RUNTIME_STATE.STARTING
      || current.status.state === BOT_RUNTIME_STATE.RUNNING
    )) {
      return
    }

    const account = await this.loadRuntimeAccount(accountId)
    if (!account) {
      return
    }

    const abortController = new AbortController()
    const entry: RuntimeEntry = {
      abortController,
      preserveDesiredStateOnStop: false,
      promise: Promise.resolve(),
      status: {
        state: BOT_RUNTIME_STATE.STARTING,
        startedAt: new Date(),
      },
    }

    this.runtimes.set(accountId, entry)
    await this.prisma.botAccount.update({
      where: { id: accountId },
      data: {
        status: BotAccountStatus.CONNECTED,
        lastError: null,
        lastStartedAt: entry.status.startedAt,
      },
    })

    entry.promise = this.runAccountLoop(account, abortController.signal)
      .catch(async (error: unknown) => {
        const message = toErrorText(error)
        entry.status = {
          ...entry.status,
          state: BOT_RUNTIME_STATE.ERROR,
          lastError: message,
          stoppedAt: new Date(),
        }
        await this.prisma.botAccount.update({
          where: { id: accountId },
          data: {
            status: BotAccountStatus.ERROR,
            lastError: message,
            lastStoppedAt: entry.status.stoppedAt,
          },
        }).catch(() => undefined)
        this.logger.warn(`weixin bot stopped with error: account=${account.accountId} ${message}`)
      })
      .finally(() => {
        const latest = this.runtimes.get(accountId)
        if (latest === entry && entry.status.state !== BOT_RUNTIME_STATE.ERROR) {
          this.runtimes.delete(accountId)
        }
      })
  }

  async stopAccount(
    accountId: string,
    options: { persistDesiredState?: boolean } = {},
  ): Promise<void> {
    const persistDesiredState = options.persistDesiredState ?? true
    const current = this.runtimes.get(accountId)

    if (!current) {
      if (!persistDesiredState) {
        await this.prisma.botAccount.update({
          where: { id: accountId },
          data: {
            lastStoppedAt: new Date(),
          },
        }).catch(() => undefined)
        return
      }

      await this.prisma.botAccount.update({
        where: { id: accountId },
        data: {
          status: BotAccountStatus.DISCONNECTED,
          lastStoppedAt: new Date(),
        },
      }).catch(() => undefined)
      return
    }

    current.preserveDesiredStateOnStop = !persistDesiredState
    current.status = {
      ...current.status,
      state: BOT_RUNTIME_STATE.STOPPING,
    }
    current.abortController.abort()
    await current.promise
    if (this.runtimes.get(accountId) === current) {
      this.runtimes.delete(accountId)
    }

    if (!persistDesiredState) {
      return
    }

    await this.prisma.botAccount.update({
      where: { id: accountId },
      data: {
        status: BotAccountStatus.DISCONNECTED,
        lastError: null,
        lastStoppedAt: new Date(),
      },
    }).catch(() => undefined)
  }

  private async startConnectedAccounts(): Promise<void> {
    const accounts = await this.prisma.botAccount.findMany({
      where: {
        channel: BotAccountChannel.WEIXIN,
        status: {
          in: [BotAccountStatus.CONNECTED, BotAccountStatus.ERROR],
        },
      },
      select: {
        id: true,
      },
    })

    for (const account of accounts) {
      await this.startAccount(account.id)
    }
  }

  private async runAccountLoop(account: WeixinRuntimeAccount, signal: AbortSignal): Promise<void> {
    const entry = this.runtimes.get(account.id)
    let getUpdatesCursor = account.getUpdatesCursor
    let nextTimeoutMs = WEIXIN_LONG_POLL_TIMEOUT_MS
    let consecutiveFailures = 0

    if (entry) {
      entry.status = {
        ...entry.status,
        state: BOT_RUNTIME_STATE.RUNNING,
        startedAt: entry.status.startedAt ?? new Date(),
      }
    }

    try {
      await this.weixinApi.notifyStart(account)
    }
    catch (error) {
      this.log(account.id, `weixin notifyStart failed, continuing: ${toErrorText(error)}`)
    }

    this.log(account.id, `weixin bot started account=${account.accountId}`)

    try {
      while (!signal.aborted) {
        try {
          const response = await this.weixinApi.getUpdates({
            abortSignal: signal,
            account,
            getUpdatesCursor,
            timeoutMs: nextTimeoutMs,
          })

          if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
            nextTimeoutMs = response.longpolling_timeout_ms
          }

          const isApiError = (response.ret !== undefined && response.ret !== 0)
            || (response.errcode !== undefined && response.errcode !== 0)

          if (isApiError) {
            if (response.ret === SESSION_EXPIRED_ERRCODE || response.errcode === SESSION_EXPIRED_ERRCODE) {
              throw new Error('微信登录态已过期，请重新绑定。')
            }

            consecutiveFailures += 1
            this.log(account.id, `weixin getUpdates failed ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ''}`)
            await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
            continue
          }

          consecutiveFailures = 0

          if (response.get_updates_buf) {
            getUpdatesCursor = response.get_updates_buf
            await this.prisma.botAccount.update({
              where: { id: account.id },
              data: {
                getUpdatesCursor,
                lastError: null,
                status: BotAccountStatus.CONNECTED,
              },
            })
          }

          for (const message of response.msgs ?? []) {
            await this.handleInboundMessage(account, message)
          }
        }
        catch (error) {
          if (signal.aborted) {
            break
          }

          if (error instanceof Error && error.message.includes('微信登录态已过期')) {
            throw error
          }

          consecutiveFailures += 1
          this.log(account.id, `weixin loop error: ${toErrorText(error)}`)
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
        }
      }
    }
    finally {
      try {
        await this.weixinApi.notifyStop(account)
      }
      catch (error) {
        this.log(account.id, `weixin notifyStop failed: ${toErrorText(error)}`)
      }

      const stoppedAt = new Date()
      const current = this.runtimes.get(account.id)
      const preserveDesiredState = current?.preserveDesiredStateOnStop ?? false
      if (current) {
        current.status = {
          ...current.status,
          state: BOT_RUNTIME_STATE.STOPPED,
          stoppedAt,
        }
      }
      await this.prisma.botAccount.update({
        where: { id: account.id },
        data: preserveDesiredState
          ? {
              lastStoppedAt: stoppedAt,
            }
          : {
              status: BotAccountStatus.DISCONNECTED,
              lastError: null,
              lastStoppedAt: stoppedAt,
            },
      }).catch(() => undefined)
    }
  }

  private async handleInboundMessage(
    account: WeixinRuntimeAccount,
    message: WeixinMessage,
  ): Promise<void> {
    if (!shouldHandleWeixinMessage(message)) {
      return
    }

    const messageKey = createWeixinMessageKey(message)
    if (!await this.rememberMessage(account.id, messageKey)) {
      return
    }

    let replyText: string | undefined

    try {
      replyText = await this.createReplyForMessage(account, message)
    }
    catch (error) {
      await this.forgetMessage(account.id, messageKey)
      this.log(account.id, `weixin agent run failed: ${toErrorText(error)}`)
      replyText = WEIXIN_AGENT_ERROR_REPLY
    }

    if (!replyText || !message.from_user_id) {
      return
    }

    await this.weixinApi.sendTextMessage({
      account,
      contextToken: message.context_token,
      text: replyText,
      to: message.from_user_id,
    })

    const now = new Date()
    await this.prisma.botAccount.update({
      where: { id: account.id },
      data: {
        lastOutboundAt: now,
      },
    })
    await this.prisma.botConversation.updateMany({
      where: {
        accountId: account.id,
        peerExternalId: message.from_user_id,
      },
      data: {
        contextToken: message.context_token,
        lastOutboundAt: now,
      },
    })
  }

  private async createReplyForMessage(
    account: WeixinRuntimeAccount,
    message: WeixinMessage,
  ): Promise<string> {
    const peerId = message.from_user_id
    if (!peerId) {
      return ''
    }

    const content = extractWeixinMessageText(message).trim().slice(0, CHAT_MESSAGE_CONTENT_MAX_LENGTH)
    if (!content) {
      return WEIXIN_UNSUPPORTED_MESSAGE_REPLY
    }

    const conversation = await this.ensureConversation(account, peerId, message.context_token)
    const mutation = await this.chatService.sendMessage({
      userId: account.ownerUserId,
      sessionId: conversation.chatSessionId,
      origin: CHAT_SESSION_ORIGIN.GLOBAL,
      allowChannelMutation: true,
      content,
      contentJSON: toPlainTextContentJSON(content),
      attachments: [],
      disabledSkillKeys: [],
    })

    const assistantMessageId = mutation.run?.assistantMessageId
    if (!assistantMessageId) {
      throw new Error('微信消息没有创建助手回复')
    }

    return this.waitForAssistantReply(assistantMessageId)
  }

  private async ensureConversation(
    account: WeixinRuntimeAccount,
    peerId: string,
    contextToken: string | undefined,
  ): Promise<{ chatSessionId: string }> {
    const existing = await this.prisma.botConversation.findUnique({
      where: {
        accountId_peerExternalId: {
          accountId: account.id,
          peerExternalId: peerId,
        },
      },
      select: {
        chatSessionId: true,
      },
    })
    const now = new Date()

    if (existing) {
      await this.prisma.botConversation.update({
        where: {
          accountId_peerExternalId: {
            accountId: account.id,
            peerExternalId: peerId,
          },
        },
        data: {
          contextToken,
          lastInboundAt: now,
        },
      })
      await this.prisma.botAccount.update({
        where: { id: account.id },
        data: {
          lastInboundAt: now,
        },
      })
      return existing
    }

    const workspace = await this.personalWorkspaces.getPersonalWorkspace(account.ownerUserId)
    const session = await this.chatSessions.createSessionForChannel({
      userId: account.ownerUserId,
      workspaceId: workspace.id,
      origin: CHAT_SESSION_ORIGIN.GLOBAL,
      channel: CHAT_SESSION_CHANNEL.WEIXIN_BOT,
      title: formatWeixinPeerTitle(peerId),
    })

    try {
      await this.prisma.botConversation.create({
        data: {
          accountId: account.id,
          peerExternalId: peerId,
          chatSessionId: session.id,
          contextToken,
          lastInboundAt: now,
        },
      })
    }
    catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error
      }

      const raced = await this.prisma.botConversation.findUnique({
        where: {
          accountId_peerExternalId: {
            accountId: account.id,
            peerExternalId: peerId,
          },
        },
        select: {
          chatSessionId: true,
        },
      })

      if (raced) {
        return raced
      }

      throw error
    }

    await this.prisma.botAccount.update({
      where: { id: account.id },
      data: {
        lastInboundAt: now,
      },
    })

    return {
      chatSessionId: session.id,
    }
  }

  private async waitForAssistantReply(assistantMessageId: string): Promise<string> {
    const deadline = Date.now() + BOT_REPLY_TIMEOUT_MS

    while (Date.now() < deadline) {
      const message = await this.prisma.chatSessionMessage.findUnique({
        where: { id: assistantMessageId },
        select: {
          status: true,
          content: true,
          metadata: true,
        },
      })

      if (!message) {
        throw new Error('微信回复消息不存在')
      }

      if (message.status === ChatSessionMessageStatus.COMPLETED) {
        return message.content.trim() || '模型没有返回文本。'
      }

      if (message.status === ChatSessionMessageStatus.FAILED) {
        return readFailureMessage(message.metadata) ?? WEIXIN_AGENT_ERROR_REPLY
      }

      if (message.status === ChatSessionMessageStatus.CANCELLED) {
        return '这次回复已取消。'
      }

      await sleep(BOT_REPLY_POLL_INTERVAL_MS)
    }

    return '回复生成时间较长，请稍后在 Lexora 对话里查看。'
  }

  private async rememberMessage(accountId: string, messageKey: string): Promise<boolean> {
    try {
      await this.prisma.botMessageReceipt.create({
        data: {
          accountId,
          messageKey,
        },
      })
      return true
    }
    catch (error) {
      if (isUniqueConstraintError(error)) {
        return false
      }

      throw error
    }
  }

  private async forgetMessage(accountId: string, messageKey: string): Promise<void> {
    await this.prisma.botMessageReceipt.deleteMany({
      where: {
        accountId,
        messageKey,
      },
    })
  }

  private async loadRuntimeAccount(accountId: string): Promise<WeixinRuntimeAccount | null> {
    const account = await this.prisma.botAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        userId: true,
        credentialEncrypted: true,
        getUpdatesCursor: true,
      },
    })

    return account ? this.credentials.decryptWeixinCredential(account) : null
  }

  private log(accountId: string, message: string): void {
    const entry = this.runtimes.get(accountId)
    if (entry) {
      entry.status = {
        ...entry.status,
        lastLog: message,
      }
    }
    this.logger.log(message)
  }
}

function readFailureMessage(metadata: Prisma.JsonValue): string | null {
  if (!isRecord(metadata) || typeof metadata.failureMessage !== 'string') {
    return null
  }

  return metadata.failureMessage.trim() || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof PrismaNamespace.PrismaClientKnownRequestError
    && error.code === 'P2002'
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }

    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })
}
