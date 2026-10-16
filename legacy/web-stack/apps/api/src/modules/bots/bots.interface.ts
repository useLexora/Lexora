export const WEIXIN_CHANNEL_ID = 'openclaw-weixin'
export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WEIXIN_DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const WEIXIN_DEFAULT_BOT_TYPE = '3'
export const WEIXIN_LOGIN_TIMEOUT_MS = 480_000
export const WEIXIN_LONG_POLL_TIMEOUT_MS = 35_000
export const WEIXIN_API_TIMEOUT_MS = 15_000

export const WeixinMessageType = {
  USER: 1,
  BOT: 2,
} as const

export const WeixinMessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

export const WeixinMessageState = {
  FINISH: 2,
} as const

export interface WeixinCredential {
  accountId: string
  baseUrl: string
  cdnBaseUrl?: string
  token: string
  userId?: string
  savedAt: string
}

export interface WeixinRuntimeAccount extends WeixinCredential {
  id: string
  ownerUserId: string
  getUpdatesCursor: string
}

export interface WeixinBaseInfo {
  channel_version?: string
  bot_agent?: string
}

export interface WeixinQrCodeResponse {
  qrcode?: string
  qrcode_img_content?: string
}

export type WeixinQrLoginStatus
  = | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect'

export interface WeixinQrStatusResponse {
  status?: WeixinQrLoginStatus
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  redirect_host?: string
}

export interface WeixinTextItem {
  text?: string
}

export interface WeixinVoiceItem {
  text?: string
}

export interface WeixinImageItem {
  aeskey?: string
  url?: string
  media?: WeixinCdnMedia
}

export interface WeixinCdnMedia {
  aes_key?: string
  encrypt_query_param?: string
  encrypt_type?: number
  full_url?: string
}

export interface WeixinRefMessage {
  message_item?: WeixinMessageItem
  title?: string
}

export interface WeixinMessageItem {
  type?: number
  image_item?: WeixinImageItem
  text_item?: WeixinTextItem
  ref_msg?: WeixinRefMessage
  voice_item?: WeixinVoiceItem
}

export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  message_type?: number
  message_state?: number
  item_list?: WeixinMessageItem[]
  context_token?: string
}

export interface WeixinGetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface WeixinSendMessageRequest {
  msg: {
    from_user_id: string
    to_user_id: string
    client_id: string
    message_type: number
    message_state: number
    item_list?: Array<{
      type: number
      text_item: {
        text: string
      }
    }>
    context_token?: string
  }
}
