import type {
  WeixinBotBindingStatus,
  WeixinBotLoginStartResponse,
  WeixinBotLoginStatusResponse,
} from '@haohaoxue/lexora-contracts'
import type { BotAccount } from '@prisma/client'
import type { WeixinCredential } from './bots.interface'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  BOT_RUNTIME_STATE,
  CHAT_SESSION_CHANNEL,
  WEIXIN_BOT_LOGIN_STATUS,
} from '@haohaoxue/lexora-contracts'
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { BotAccountChannel, BotAccountStatus } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { BotCredentialsService } from './bot-credentials.service'
import {
  WEIXIN_DEFAULT_BASE_URL,
  WEIXIN_DEFAULT_CDN_BASE_URL,
  WEIXIN_LOGIN_TIMEOUT_MS,
} from './bots.interface'
import { WeixinBotRuntimeService } from './weixin-bot-runtime.service'
import { WeixinOpenClawApiService } from './weixin-openclaw-api.service'

interface QrCodePackage {
  toDataURL: (text: string, options: { errorCorrectionLevel: string, margin: number, width: number }) => Promise<string>
}

interface WeixinLoginSession {
  id: string
  userId: string
  qrcode: string
  qrCodeText: string
  qrCodeDataUrl: string
  baseUrl: string
  expiresAt: Date
  pendingVerifyCode?: string
  qrRefreshCount: number
}

const require = createRequire(import.meta.url)
const qrcode = require('qrcode') as QrCodePackage

const MAX_QR_REFRESH_COUNT = 3

@Injectable()
export class BotsService {
  private readonly loginSessions = new Map<string, WeixinLoginSession>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: BotCredentialsService,
    private readonly weixinApi: WeixinOpenClawApiService,
    private readonly weixinRuntime: WeixinBotRuntimeService,
  ) {}

  async getWeixinStatus(userId: string): Promise<WeixinBotBindingStatus> {
    const account = await this.findLatestWeixinAccount(userId)
    return this.toWeixinBindingStatus(account)
  }

  async startWeixinLogin(userId: string): Promise<WeixinBotLoginStartResponse> {
    const existing = await this.findLatestWeixinAccount(userId)
    const localTokenList = existing
      ? [this.credentials.decryptWeixinCredential(existing).token]
      : []
    const qrCode = await this.createQrCode(localTokenList)
    const session: WeixinLoginSession = {
      id: randomUUID(),
      userId,
      qrcode: qrCode.qrcode,
      qrCodeText: qrCode.text,
      qrCodeDataUrl: qrCode.dataUrl,
      baseUrl: WEIXIN_DEFAULT_BASE_URL,
      expiresAt: new Date(Date.now() + WEIXIN_LOGIN_TIMEOUT_MS),
      qrRefreshCount: 1,
    }

    this.loginSessions.set(session.id, session)

    return {
      loginId: session.id,
      qrCodeText: session.qrCodeText,
      qrCodeDataUrl: session.qrCodeDataUrl,
      status: WEIXIN_BOT_LOGIN_STATUS.WAITING,
      message: '请使用微信扫描二维码并在手机上确认绑定。',
      expiresAt: session.expiresAt.toISOString(),
    }
  }

  async getWeixinLoginStatus(userId: string, loginId: string): Promise<WeixinBotLoginStatusResponse> {
    const session = this.getLoginSessionOrThrow(userId, loginId)

    if (Date.now() > session.expiresAt.getTime()) {
      this.loginSessions.delete(loginId)
      return this.createLoginStatusResponse(session, {
        status: WEIXIN_BOT_LOGIN_STATUS.EXPIRED,
        message: '二维码已超时，请重新发起绑定。',
      })
    }

    const response = await this.weixinApi.getQrStatus({
      baseUrl: session.baseUrl,
      qrcode: session.qrcode,
      verifyCode: session.pendingVerifyCode,
    })

    switch (response.status) {
      case 'scaned':
        session.pendingVerifyCode = undefined
        return this.createLoginStatusResponse(session, {
          status: WEIXIN_BOT_LOGIN_STATUS.SCANNED,
          message: '已扫码，等待手机确认。',
        })

      case 'need_verifycode':
        return this.createLoginStatusResponse(session, {
          status: WEIXIN_BOT_LOGIN_STATUS.NEED_VERIFY_CODE,
          message: '请输入手机微信显示的验证码。',
        })

      case 'scaned_but_redirect':
        if (response.redirect_host) {
          session.baseUrl = `https://${response.redirect_host}`
        }
        return this.createLoginStatusResponse(session, {
          status: WEIXIN_BOT_LOGIN_STATUS.SCANNED,
          message: '已扫码，正在跳转确认。',
        })

      case 'expired':
      case 'verify_code_blocked':
        return this.refreshExpiredQrCode(session)

      case 'binded_redirect': {
        const account = await this.findLatestWeixinAccount(userId)
        if (!account) {
          return this.createLoginStatusResponse(session, {
            status: WEIXIN_BOT_LOGIN_STATUS.ERROR,
            message: '此微信账号已绑定过，但当前用户没有可用凭证，请重新扫码。',
          })
        }

        this.loginSessions.delete(loginId)
        return this.createLoginStatusResponse(session, {
          status: WEIXIN_BOT_LOGIN_STATUS.CONFIRMED,
          message: '微信账号已绑定。',
          account: this.toWeixinBindingStatus(account),
        })
      }

      case 'confirmed':
        return this.confirmWeixinLogin(userId, loginId, session, response)

      case 'wait':
      case undefined:
        return this.createLoginStatusResponse(session, {
          status: WEIXIN_BOT_LOGIN_STATUS.WAITING,
          message: '等待扫码确认。',
        })
    }
  }

  async submitWeixinVerifyCode(
    userId: string,
    loginId: string,
    verifyCode: string,
  ): Promise<WeixinBotLoginStatusResponse> {
    const session = this.getLoginSessionOrThrow(userId, loginId)
    session.pendingVerifyCode = verifyCode.trim()
    return this.getWeixinLoginStatus(userId, loginId)
  }

  async startWeixinBot(userId: string): Promise<WeixinBotBindingStatus> {
    const account = await this.findLatestWeixinAccount(userId)

    if (!account) {
      throw new NotFoundException('未绑定微信 Bot')
    }

    await this.weixinRuntime.startAccount(account.id)
    return this.toWeixinBindingStatus(await this.findLatestWeixinAccount(userId))
  }

  async stopWeixinBot(userId: string): Promise<WeixinBotBindingStatus> {
    const account = await this.findLatestWeixinAccount(userId)

    if (!account) {
      throw new NotFoundException('未绑定微信 Bot')
    }

    await this.weixinRuntime.stopAccount(account.id)
    return this.toWeixinBindingStatus(await this.findLatestWeixinAccount(userId))
  }

  async disconnectWeixin(userId: string): Promise<null> {
    const account = await this.findLatestWeixinAccount(userId)

    if (!account) {
      return null
    }

    await this.weixinRuntime.stopAccount(account.id)
    await this.prisma.botAccount.delete({
      where: { id: account.id },
    })

    return null
  }

  private async confirmWeixinLogin(
    userId: string,
    loginId: string,
    session: WeixinLoginSession,
    response: {
      bot_token?: string
      ilink_bot_id?: string
      ilink_user_id?: string
      baseurl?: string
    },
  ): Promise<WeixinBotLoginStatusResponse> {
    if (!response.ilink_bot_id || !response.bot_token) {
      return this.createLoginStatusResponse(session, {
        status: WEIXIN_BOT_LOGIN_STATUS.ERROR,
        message: '微信登录失败：服务端没有返回账号凭证。',
      })
    }

    const credential: WeixinCredential = {
      accountId: response.ilink_bot_id,
      baseUrl: response.baseurl || session.baseUrl,
      cdnBaseUrl: WEIXIN_DEFAULT_CDN_BASE_URL,
      savedAt: new Date().toISOString(),
      token: response.bot_token,
      ...(response.ilink_user_id ? { userId: response.ilink_user_id } : {}),
    }

    const externalOwner = await this.prisma.botAccount.findUnique({
      where: {
        channel_externalAccountId: {
          channel: BotAccountChannel.WEIXIN,
          externalAccountId: credential.accountId,
        },
      },
      select: {
        id: true,
        userId: true,
      },
    })

    if (externalOwner && externalOwner.userId !== userId) {
      throw new ConflictException('微信 Bot 已绑定到其他用户')
    }

    const staleAccounts = await this.prisma.botAccount.findMany({
      where: {
        userId,
        channel: BotAccountChannel.WEIXIN,
        ...(externalOwner ? { id: { not: externalOwner.id } } : {}),
      },
      select: {
        id: true,
      },
    })

    for (const staleAccount of staleAccounts) {
      await this.weixinRuntime.stopAccount(staleAccount.id)
    }

    if (staleAccounts.length > 0) {
      await this.prisma.botAccount.deleteMany({
        where: {
          id: { in: staleAccounts.map(account => account.id) },
        },
      })
    }

    const account = await this.prisma.botAccount.upsert({
      where: {
        channel_externalAccountId: {
          channel: BotAccountChannel.WEIXIN,
          externalAccountId: credential.accountId,
        },
      },
      create: {
        userId,
        channel: BotAccountChannel.WEIXIN,
        externalAccountId: credential.accountId,
        externalUserId: credential.userId,
        credentialEncrypted: this.credentials.encryptWeixinCredential(credential),
        status: BotAccountStatus.CONNECTED,
        lastError: null,
      },
      update: {
        externalUserId: credential.userId,
        credentialEncrypted: this.credentials.encryptWeixinCredential(credential),
        status: BotAccountStatus.CONNECTED,
        lastError: null,
      },
    })

    this.loginSessions.delete(loginId)
    await this.weixinRuntime.startAccount(account.id)

    return this.createLoginStatusResponse(session, {
      status: WEIXIN_BOT_LOGIN_STATUS.CONFIRMED,
      message: '微信 Bot 已绑定并开始接收消息。',
      account: this.toWeixinBindingStatus(await this.prisma.botAccount.findUnique({ where: { id: account.id } })),
    })
  }

  private async refreshExpiredQrCode(
    session: WeixinLoginSession,
  ): Promise<WeixinBotLoginStatusResponse> {
    session.qrRefreshCount += 1

    if (session.qrRefreshCount > MAX_QR_REFRESH_COUNT) {
      this.loginSessions.delete(session.id)
      return this.createLoginStatusResponse(session, {
        status: WEIXIN_BOT_LOGIN_STATUS.EXPIRED,
        message: '二维码多次失效，请重新发起绑定。',
      })
    }

    const qrCode = await this.createQrCode([])
    session.qrcode = qrCode.qrcode
    session.qrCodeText = qrCode.text
    session.qrCodeDataUrl = qrCode.dataUrl
    session.baseUrl = WEIXIN_DEFAULT_BASE_URL
    session.expiresAt = new Date(Date.now() + WEIXIN_LOGIN_TIMEOUT_MS)
    session.pendingVerifyCode = undefined

    return this.createLoginStatusResponse(session, {
      status: WEIXIN_BOT_LOGIN_STATUS.WAITING,
      message: '二维码已刷新，请重新扫码。',
      includeQrCode: true,
    })
  }

  private async createQrCode(localTokenList: string[]): Promise<{
    qrcode: string
    text: string
    dataUrl: string
  }> {
    const response = await this.weixinApi.fetchQrCode(localTokenList)

    if (!response.qrcode || !response.qrcode_img_content) {
      throw new BadRequestException('微信登录失败：服务端没有返回二维码')
    }

    return {
      qrcode: response.qrcode,
      text: response.qrcode_img_content,
      dataUrl: await qrcode.toDataURL(response.qrcode_img_content, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 280,
      }),
    }
  }

  private createLoginStatusResponse(
    session: WeixinLoginSession,
    input: {
      status: WeixinBotLoginStatusResponse['status']
      message: string
      account?: WeixinBotBindingStatus | null
      includeQrCode?: boolean
    },
  ): WeixinBotLoginStatusResponse {
    return {
      loginId: session.id,
      ...(input.includeQrCode
        ? {
            qrCodeText: session.qrCodeText,
            qrCodeDataUrl: session.qrCodeDataUrl,
          }
        : {}),
      status: input.status,
      message: input.message,
      expiresAt: session.expiresAt.toISOString(),
      account: input.account ?? null,
    }
  }

  private getLoginSessionOrThrow(userId: string, loginId: string): WeixinLoginSession {
    const session = this.loginSessions.get(loginId)

    if (!session || session.userId !== userId) {
      throw new NotFoundException('微信登录会话不存在')
    }

    return session
  }

  private async findLatestWeixinAccount(userId: string): Promise<BotAccount | null> {
    return this.prisma.botAccount.findFirst({
      where: {
        userId,
        channel: BotAccountChannel.WEIXIN,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    })
  }

  private toWeixinBindingStatus(account: BotAccount | null): WeixinBotBindingStatus {
    if (!account) {
      return {
        channel: CHAT_SESSION_CHANNEL.WEIXIN_BOT,
        bound: false,
        accountId: null,
        externalUserId: null,
        runtimeState: BOT_RUNTIME_STATE.NOT_BOUND,
        lastError: null,
        lastLog: null,
        lastStartedAt: null,
        lastStoppedAt: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        updatedAt: null,
      }
    }

    const runtimeStatus = this.weixinRuntime.getStatus(account.id)
    const runtimeState = runtimeStatus.state === BOT_RUNTIME_STATE.NOT_BOUND
      ? account.status === BotAccountStatus.ERROR ? BOT_RUNTIME_STATE.ERROR : BOT_RUNTIME_STATE.STOPPED
      : runtimeStatus.state

    return {
      channel: CHAT_SESSION_CHANNEL.WEIXIN_BOT,
      bound: true,
      accountId: account.externalAccountId,
      externalUserId: account.externalUserId,
      runtimeState,
      lastError: runtimeStatus.lastError ?? account.lastError,
      lastLog: runtimeStatus.lastLog ?? null,
      lastStartedAt: (runtimeStatus.startedAt ?? account.lastStartedAt)?.toISOString() ?? null,
      lastStoppedAt: (runtimeStatus.stoppedAt ?? account.lastStoppedAt)?.toISOString() ?? null,
      lastInboundAt: account.lastInboundAt?.toISOString() ?? null,
      lastOutboundAt: account.lastOutboundAt?.toISOString() ?? null,
      updatedAt: account.updatedAt.toISOString(),
    }
  }
}
