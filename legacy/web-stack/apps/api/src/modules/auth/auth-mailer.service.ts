import type { ResolvedLanguagePreference } from '@haohaoxue/lexora-contracts'
import { LANGUAGE_PREFERENCE } from '@haohaoxue/lexora-contracts/user/constants'
import { Injectable } from '@nestjs/common'
import { SystemEmailService } from '../system-email/system-email.service'
import { stripHtmlTags } from './html.utils'

interface RegistrationVerificationMailPayload {
  email: string
  code: string
  language: ResolvedLanguagePreference
}

interface BindEmailCodeMailPayload {
  email: string
  code: string
  language: ResolvedLanguagePreference
}

@Injectable()
export class AuthMailerService {
  constructor(private readonly systemEmailService: SystemEmailService) {}

  async sendRegistrationCodeEmail(payload: RegistrationVerificationMailPayload): Promise<void> {
    const template = createRegistrationTemplate(payload.language, payload.code)
    const html = createVerificationEmailHtml(template)

    await this.systemEmailService.sendMail({
      to: payload.email,
      subject: template.subject,
      html,
      text: stripHtmlTags(html),
    })
  }

  async sendBindEmailCodeEmail(payload: BindEmailCodeMailPayload): Promise<void> {
    const template = createBindEmailTemplate(payload.language, payload.code)
    const html = createVerificationEmailHtml(template)

    await this.systemEmailService.sendMail({
      to: payload.email,
      subject: template.subject,
      html,
      text: stripHtmlTags(html),
    })
  }
}

function createVerificationEmailHtml(input: {
  title: string
  intro: string
  code: string
  note: string
}) {
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.7;">',
    `<h2 style="margin:0 0 16px;">${input.title}</h2>`,
    `<p style="margin:0 0 12px;">${input.intro}</p>`,
    `<p style="margin:0 0 12px;font-size:24px;font-weight:700;letter-spacing:6px;">${input.code}</p>`,
    `<p style="margin:0;color:#6b7280;">${input.note}</p>`,
    '</div>',
  ].join('')
}

function createRegistrationTemplate(language: ResolvedLanguagePreference, code: string) {
  if (language === LANGUAGE_PREFERENCE.ZH_CN) {
    return {
      subject: 'Lexora 注册验证码',
      title: '注册验证码',
      intro: '你正在注册 Lexora，请在页面输入以下验证码：',
      code,
      note: '验证码 10 分钟内有效。如非本人操作，请忽略这封邮件。',
    }
  }

  return {
    subject: 'Lexora registration code',
    title: 'Registration code',
    intro: 'Enter this verification code on Lexora to finish registration:',
    code,
    note: 'This code is valid for 10 minutes. If you did not request it, ignore this email.',
  }
}

function createBindEmailTemplate(language: ResolvedLanguagePreference, code: string) {
  if (language === LANGUAGE_PREFERENCE.ZH_CN) {
    return {
      subject: 'Lexora 邮箱绑定验证码',
      title: '邮箱绑定验证码',
      intro: '你正在绑定 Lexora 登录邮箱，请在页面输入以下验证码：',
      code,
      note: '验证码 10 分钟内有效。如非本人操作，请忽略这封邮件。',
    }
  }

  return {
    subject: 'Lexora email binding code',
    title: 'Email binding code',
    intro: 'Enter this verification code on Lexora to bind your sign-in email:',
    code,
    note: 'This code is valid for 10 minutes. If you did not request it, ignore this email.',
  }
}
