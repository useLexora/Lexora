import { z } from 'zod'
import { CHAT_SESSION_CHANNEL } from './chat/constants'

const IsoDateTimeStringSchema = z.string().datetime()
const NonEmptyStringSchema = z.string().trim().min(1)

export const WEIXIN_BOT_LOGIN_STATUS = {
  WAITING: 'waiting',
  SCANNED: 'scanned',
  NEED_VERIFY_CODE: 'need_verify_code',
  CONFIRMED: 'confirmed',
  EXPIRED: 'expired',
  ERROR: 'error',
} as const

export const WEIXIN_BOT_LOGIN_STATUS_VALUES = [
  WEIXIN_BOT_LOGIN_STATUS.WAITING,
  WEIXIN_BOT_LOGIN_STATUS.SCANNED,
  WEIXIN_BOT_LOGIN_STATUS.NEED_VERIFY_CODE,
  WEIXIN_BOT_LOGIN_STATUS.CONFIRMED,
  WEIXIN_BOT_LOGIN_STATUS.EXPIRED,
  WEIXIN_BOT_LOGIN_STATUS.ERROR,
] as const

export const BOT_RUNTIME_STATE = {
  NOT_BOUND: 'not_bound',
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
} as const

export const BOT_RUNTIME_STATE_VALUES = [
  BOT_RUNTIME_STATE.NOT_BOUND,
  BOT_RUNTIME_STATE.STOPPED,
  BOT_RUNTIME_STATE.STARTING,
  BOT_RUNTIME_STATE.RUNNING,
  BOT_RUNTIME_STATE.STOPPING,
  BOT_RUNTIME_STATE.ERROR,
] as const

export const WeixinBotBindingStatusSchema = z.object({
  channel: z.literal(CHAT_SESSION_CHANNEL.WEIXIN_BOT),
  bound: z.boolean(),
  accountId: NonEmptyStringSchema.nullable(),
  externalUserId: NonEmptyStringSchema.nullable(),
  runtimeState: z.enum(BOT_RUNTIME_STATE_VALUES),
  lastError: z.string().trim().min(1).nullable(),
  lastLog: z.string().trim().min(1).nullable(),
  lastStartedAt: IsoDateTimeStringSchema.nullable(),
  lastStoppedAt: IsoDateTimeStringSchema.nullable(),
  lastInboundAt: IsoDateTimeStringSchema.nullable(),
  lastOutboundAt: IsoDateTimeStringSchema.nullable(),
  updatedAt: IsoDateTimeStringSchema.nullable(),
}).strict()

export const WeixinBotLoginStartResponseSchema = z.object({
  loginId: NonEmptyStringSchema,
  qrCodeText: NonEmptyStringSchema,
  qrCodeDataUrl: NonEmptyStringSchema,
  status: z.enum(WEIXIN_BOT_LOGIN_STATUS_VALUES),
  message: z.string().trim().min(1),
  expiresAt: IsoDateTimeStringSchema,
}).strict()

export const SubmitWeixinBotVerifyCodeRequestSchema = z.object({
  verifyCode: z.string().trim().min(1).max(12),
}).strict()

export const WeixinBotLoginStatusResponseSchema = WeixinBotLoginStartResponseSchema
  .partial({
    qrCodeText: true,
    qrCodeDataUrl: true,
  })
  .extend({
    account: WeixinBotBindingStatusSchema.nullable(),
  })
  .strict()

export type WeixinBotLoginStatus = z.infer<typeof WeixinBotLoginStatusResponseSchema>['status']
export type BotRuntimeState = z.infer<typeof WeixinBotBindingStatusSchema>['runtimeState']
export type WeixinBotBindingStatus = z.infer<typeof WeixinBotBindingStatusSchema>
export type WeixinBotLoginStartResponse = z.infer<typeof WeixinBotLoginStartResponseSchema>
export type SubmitWeixinBotVerifyCodeRequest = z.infer<typeof SubmitWeixinBotVerifyCodeRequestSchema>
export type WeixinBotLoginStatusResponse = z.infer<typeof WeixinBotLoginStatusResponseSchema>
