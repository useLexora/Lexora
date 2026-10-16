import type {
  SubmitWeixinBotVerifyCodeRequest,
  WeixinBotBindingStatus,
  WeixinBotLoginStartResponse,
  WeixinBotLoginStatusResponse,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export function getWeixinBotStatus(): Promise<WeixinBotBindingStatus> {
  return axios.request({
    method: 'get',
    url: '/bot-accounts/weixin',
  })
}

export function startWeixinBotLogin(): Promise<WeixinBotLoginStartResponse> {
  return axios.request({
    method: 'post',
    url: '/bot-accounts/weixin/login',
  })
}

export function getWeixinBotLoginStatus(loginId: string): Promise<WeixinBotLoginStatusResponse> {
  return axios.request({
    method: 'get',
    url: `/bot-accounts/weixin/login/${loginId}`,
  })
}

export function submitWeixinBotVerifyCode(
  loginId: string,
  data: SubmitWeixinBotVerifyCodeRequest,
): Promise<WeixinBotLoginStatusResponse> {
  return axios.request({
    method: 'post',
    url: `/bot-accounts/weixin/login/${loginId}/verify-code`,
    data,
  })
}

export function startWeixinBot(): Promise<WeixinBotBindingStatus> {
  return axios.request({
    method: 'post',
    url: '/bot-accounts/weixin/start',
  })
}

export function stopWeixinBot(): Promise<WeixinBotBindingStatus> {
  return axios.request({
    method: 'post',
    url: '/bot-accounts/weixin/stop',
  })
}

export function disconnectWeixinBot(): Promise<null> {
  return axios.request({
    method: 'delete',
    url: '/bot-accounts/weixin',
  })
}
