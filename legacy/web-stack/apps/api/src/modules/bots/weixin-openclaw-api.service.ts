import type {
  WeixinBaseInfo,
  WeixinCredential,
  WeixinGetUpdatesResponse,
  WeixinQrCodeResponse,
  WeixinQrStatusResponse,
  WeixinSendMessageRequest,
} from './bots.interface'
import { Buffer } from 'node:buffer'
import crypto, { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { Injectable } from '@nestjs/common'
import {
  WEIXIN_API_TIMEOUT_MS,
  WEIXIN_DEFAULT_BASE_URL,
  WEIXIN_DEFAULT_BOT_TYPE,
  WEIXIN_LONG_POLL_TIMEOUT_MS,
  WeixinMessageItemType,
  WeixinMessageState,
  WeixinMessageType,
} from './bots.interface'

interface OpenClawWeixinPackageJson {
  version?: string
  ilink_appid?: string
}

interface JsonRequestOptions {
  baseUrl: string
  endpoint: string
  label: string
  timeoutMs?: number
  token?: string
  abortSignal?: AbortSignal
}

interface PostJsonRequestOptions extends JsonRequestOptions {
  body: unknown
}

const require = createRequire(import.meta.url)

@Injectable()
export class WeixinOpenClawApiService {
  private readonly packageInfo = readOpenClawWeixinPackageInfo()
  private readonly channelVersion = this.packageInfo.version ?? '0.0.0'
  private readonly ilinkAppId = this.packageInfo.ilink_appid ?? 'bot'
  private readonly ilinkAppClientVersion = buildClientVersion(this.channelVersion)

  async fetchQrCode(localTokenList: string[]): Promise<WeixinQrCodeResponse> {
    return await this.apiPostJson<WeixinQrCodeResponse>({
      baseUrl: WEIXIN_DEFAULT_BASE_URL,
      body: {
        local_token_list: localTokenList,
      },
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WEIXIN_DEFAULT_BOT_TYPE)}`,
      label: 'fetchWeixinQrCode',
    })
  }

  async getQrStatus(params: {
    baseUrl: string
    qrcode: string
    verifyCode?: string
  }): Promise<WeixinQrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`

    if (params.verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`
    }

    try {
      return await this.apiGetJson<WeixinQrStatusResponse>({
        baseUrl: params.baseUrl,
        endpoint,
        label: 'getWeixinQrStatus',
        timeoutMs: WEIXIN_LONG_POLL_TIMEOUT_MS,
      })
    }
    catch (error) {
      if (isAbortLikeError(error)) {
        return { status: 'wait' }
      }

      throw error
    }
  }

  async getUpdates(params: {
    account: WeixinCredential
    getUpdatesCursor: string
    timeoutMs?: number
    abortSignal?: AbortSignal
  }): Promise<WeixinGetUpdatesResponse> {
    try {
      return await this.apiPostJson<WeixinGetUpdatesResponse>({
        abortSignal: params.abortSignal,
        baseUrl: params.account.baseUrl,
        body: {
          base_info: this.buildBaseInfo(),
          get_updates_buf: params.getUpdatesCursor,
        },
        endpoint: 'ilink/bot/getupdates',
        label: 'getWeixinUpdates',
        timeoutMs: params.timeoutMs ?? WEIXIN_LONG_POLL_TIMEOUT_MS,
        token: params.account.token,
      })
    }
    catch (error) {
      if (isAbortLikeError(error)) {
        return {
          get_updates_buf: params.getUpdatesCursor,
          msgs: [],
          ret: 0,
        }
      }

      throw error
    }
  }

  async sendTextMessage(params: {
    account: WeixinCredential
    contextToken?: string
    text: string
    to: string
  }): Promise<void> {
    const request: WeixinSendMessageRequest = {
      msg: {
        client_id: `lexora-weixin-${randomUUID()}`,
        context_token: params.contextToken,
        from_user_id: '',
        item_list: params.text
          ? [{
              text_item: {
                text: params.text,
              },
              type: WeixinMessageItemType.TEXT,
            }]
          : undefined,
        message_state: WeixinMessageState.FINISH,
        message_type: WeixinMessageType.BOT,
        to_user_id: params.to,
      },
    }

    await this.apiPostJson<void>({
      baseUrl: params.account.baseUrl,
      body: {
        ...request,
        base_info: this.buildBaseInfo(),
      },
      endpoint: 'ilink/bot/sendmessage',
      label: 'sendWeixinTextMessage',
      timeoutMs: WEIXIN_API_TIMEOUT_MS,
      token: params.account.token,
    })
  }

  async notifyStart(account: WeixinCredential): Promise<void> {
    await this.apiPostJson({
      baseUrl: account.baseUrl,
      body: {
        base_info: this.buildBaseInfo(),
      },
      endpoint: 'ilink/bot/msg/notifystart',
      label: 'notifyWeixinStart',
      timeoutMs: WEIXIN_API_TIMEOUT_MS,
      token: account.token,
    })
  }

  async notifyStop(account: WeixinCredential): Promise<void> {
    await this.apiPostJson({
      baseUrl: account.baseUrl,
      body: {
        base_info: this.buildBaseInfo(),
      },
      endpoint: 'ilink/bot/msg/notifystop',
      label: 'notifyWeixinStop',
      timeoutMs: WEIXIN_API_TIMEOUT_MS,
      token: account.token,
    })
  }

  private buildBaseInfo(): WeixinBaseInfo {
    return {
      channel_version: this.channelVersion,
      bot_agent: `Lexora/1.0.0 openclaw-weixin/${this.channelVersion}`,
    }
  }

  private buildCommonHeaders(): Record<string, string> {
    return {
      'iLink-App-Id': this.ilinkAppId,
      'iLink-App-ClientVersion': String(this.ilinkAppClientVersion),
    }
  }

  private buildJsonHeaders(token?: string): Record<string, string> {
    return {
      ...this.buildCommonHeaders(),
      'AuthorizationType': 'ilink_bot_token',
      'Content-Type': 'application/json',
      'X-WECHAT-UIN': randomWechatUin(),
      ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
    }
  }

  private async apiGetJson<T>(options: JsonRequestOptions): Promise<T> {
    const url = new URL(options.endpoint, ensureTrailingSlash(options.baseUrl))
    const signal = options.timeoutMs
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined

    const response = await fetch(url, {
      headers: this.buildCommonHeaders(),
      method: 'GET',
      ...(signal ? { signal } : {}),
    })
    const rawText = await response.text()

    if (!response.ok) {
      throw new Error(`${options.label} ${response.status}: ${rawText}`)
    }

    return JSON.parse(rawText) as T
  }

  private async apiPostJson<T>(options: PostJsonRequestOptions): Promise<T> {
    const url = new URL(options.endpoint, ensureTrailingSlash(options.baseUrl))
    const signal = resolveAbortSignal([
      options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined,
      options.abortSignal,
    ])

    const response = await fetch(url, {
      body: JSON.stringify(options.body),
      headers: this.buildJsonHeaders(options.token),
      method: 'POST',
      ...(signal ? { signal } : {}),
    })
    const rawText = await response.text()

    if (!response.ok) {
      throw new Error(`${options.label} ${response.status}: ${rawText}`)
    }

    if (!rawText) {
      return {} as T
    }

    return JSON.parse(rawText) as T
  }
}

function readOpenClawWeixinPackageInfo(): OpenClawWeixinPackageJson {
  try {
    const packagePath = require.resolve('@tencent-weixin/openclaw-weixin/package.json')
    return JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as OpenClawWeixinPackageJson
  }
  catch {
    return {}
  }
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .map(part => (Number.isFinite(part) ? part : 0))

  return ((major & 0xFF) << 16) | ((minor & 0xFF) << 8) | (patch & 0xFF)
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function resolveAbortSignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const availableSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (availableSignals.length === 0) {
    return undefined
  }

  return availableSignals.length === 1
    ? availableSignals[0]
    : AbortSignal.any(availableSignals)
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
