import type {
  ResolvedLanguagePreference,
  SystemEmailConfig,
  SystemEmailProvider,
  SystemEmailServiceStatus,
  TestSystemEmailConfigResponse,
  UpdateSystemEmailConfigRequest,
  UpdateSystemEmailServiceStatusRequest,
} from '@haohaoxue/lexora-contracts'
import type { CryptoConfig } from '../../config/auth.config'
import { API_ERROR_CODE, SYSTEM_EMAIL_PROVIDER_DEFAULTS } from '@haohaoxue/lexora-contracts'
import { LANGUAGE_PREFERENCE } from '@haohaoxue/lexora-contracts/user/constants'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma, SystemEmailProvider as PrismaSystemEmailProvider } from '@prisma/client'
import { createTransport } from 'nodemailer'
import { PrismaService } from '../../database/prisma.service'
import { apiBadRequest } from '../../utils/api-error'
import { decryptAes256Gcm, encryptAes256Gcm, isEncryptedValue } from '../../utils/crypto'
import { auditUserSummarySelect, toAuditUserSummary } from '../users/audit-user-summary'
import {
  createDefaultSystemEmailConfig,
  normalizeSystemEmailEditableFields,
  toSystemEmailConfig,
  toSystemEmailServiceStatus,
} from './system-email.utils'

const systemEmailConfigInclude = {
  updatedByUser: {
    select: auditUserSummarySelect,
  },
} satisfies Prisma.SystemEmailConfigInclude

@Injectable()
export class SystemEmailService {
  private readonly encryptionKey: string

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.encryptionKey = configService.getOrThrow<CryptoConfig>('crypto').encryptionKey
  }

  async getEmailConfig(): Promise<SystemEmailConfig> {
    const config = await this.prisma.systemEmailConfig.findFirst({
      orderBy: { updatedAt: 'desc' },
      include: systemEmailConfigInclude,
    })

    if (!config) {
      return createDefaultSystemEmailConfig()
    }

    const normalizedFields = normalizeSystemEmailEditableFields({
      smtpHost: config.smtpHost,
      smtpUsername: config.smtpUsername,
      fromName: config.fromName,
      fromEmail: config.fromEmail,
    })

    return toSystemEmailConfig({
      provider: config.provider as SystemEmailProvider,
      smtpHost: normalizedFields.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      smtpUsername: normalizedFields.smtpUsername,
      fromName: normalizedFields.fromName,
      fromEmail: normalizedFields.fromEmail,
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
      updatedByUser: toAuditUserSummary(config.updatedByUser),
    }, Boolean(this.decryptPassword(config.smtpPasswordEncrypted)))
  }

  async getEmailServiceStatus(): Promise<SystemEmailServiceStatus> {
    const config = await this.prisma.systemEmailConfig.findFirst({
      orderBy: { updatedAt: 'desc' },
    })

    return toSystemEmailServiceStatus(config
      ? {
          enabled: config.enabled,
        }
      : null)
  }

  async isEnabled(): Promise<boolean> {
    return (await this.getEmailServiceStatus()).enabled
  }

  async updateEmailConfig(
    actorUserId: string,
    payload: UpdateSystemEmailConfigRequest,
  ): Promise<SystemEmailConfig> {
    const existing = await this.prisma.systemEmailConfig.findFirst({
      orderBy: { updatedAt: 'desc' },
    })
    const existingPassword = this.decryptPassword(existing?.smtpPasswordEncrypted ?? null)
    const nextPassword = payload.clearPassword
      ? null
      : payload.smtpPassword?.trim()
        ? payload.smtpPassword.trim()
        : existingPassword
    const normalizedFields = normalizeSystemEmailEditableFields({
      smtpHost: payload.smtpHost,
      smtpUsername: payload.smtpUsername,
      fromName: payload.fromName,
      fromEmail: payload.fromEmail,
    })

    if (existing?.enabled) {
      this.assertEmailServiceReady({
        smtpHost: normalizedFields.smtpHost,
        smtpPort: payload.smtpPort,
        smtpUsername: normalizedFields.smtpUsername,
        fromName: normalizedFields.fromName,
        fromEmail: normalizedFields.fromEmail,
        smtpPassword: nextPassword,
      })
    }

    const data = {
      provider: payload.provider as PrismaSystemEmailProvider,
      enabled: existing?.enabled ?? false,
      smtpHost: normalizedFields.smtpHost,
      smtpPort: payload.smtpPort,
      smtpSecure: payload.smtpSecure,
      smtpUsername: normalizedFields.smtpUsername,
      smtpPasswordEncrypted: nextPassword ? encryptAes256Gcm(nextPassword, this.encryptionKey) : null,
      fromName: normalizedFields.fromName,
      fromEmail: normalizedFields.fromEmail,
      updatedBy: actorUserId,
    }

    if (existing) {
      await this.prisma.systemEmailConfig.update({
        where: { id: existing.id },
        data,
      })
    }
    else {
      await this.prisma.systemEmailConfig.create({
        data: {
          id: 'default',
          ...data,
        },
      })
    }

    return this.getEmailConfig()
  }

  async updateEmailServiceStatus(
    actorUserId: string,
    payload: UpdateSystemEmailServiceStatusRequest,
  ): Promise<SystemEmailServiceStatus> {
    const existing = await this.prisma.systemEmailConfig.findFirst({
      orderBy: { updatedAt: 'desc' },
    })
    const normalizedFields = normalizeSystemEmailEditableFields({
      smtpHost: existing?.smtpHost ?? '',
      smtpUsername: existing?.smtpUsername ?? '',
      fromName: existing?.fromName ?? '',
      fromEmail: existing?.fromEmail ?? '',
    })

    if (payload.enabled) {
      this.assertEmailServiceReady({
        smtpHost: normalizedFields.smtpHost,
        smtpPort: existing?.smtpPort ?? 0,
        smtpUsername: normalizedFields.smtpUsername,
        fromName: normalizedFields.fromName,
        fromEmail: normalizedFields.fromEmail,
        smtpPassword: this.decryptPassword(existing?.smtpPasswordEncrypted ?? null),
      })
    }

    if (!existing) {
      return toSystemEmailServiceStatus(null)
    }

    await this.prisma.systemEmailConfig.update({
      where: { id: existing.id },
      data: {
        enabled: payload.enabled,
        updatedBy: actorUserId,
      },
    })

    return this.getEmailServiceStatus()
  }

  async sendTestEmail(
    recipientEmail: string,
    language: ResolvedLanguagePreference = LANGUAGE_PREFERENCE.EN_US,
  ): Promise<TestSystemEmailConfigResponse> {
    const config = await this.getTransportConfig(false)
    const template = createTestEmailTemplate(language)
    const transport = createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: config.smtpUsername,
        pass: config.smtpPassword,
      },
    })

    await transport.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: recipientEmail,
      subject: template.subject,
      html: createSimpleEmailHtml(template),
      text: template.content,
    })

    return { sent: true }
  }

  async sendMail(input: {
    to: string
    subject: string
    html: string
    text: string
  }): Promise<void> {
    const config = await this.getTransportConfig(true)
    const transport = createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: config.smtpUsername,
        pass: config.smtpPassword,
      },
    })

    await transport.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    })
  }

  getProviderDefaults(provider: SystemEmailProvider) {
    return SYSTEM_EMAIL_PROVIDER_DEFAULTS[provider]
  }

  private assertEmailServiceReady(input: {
    smtpHost: string
    smtpPort: number
    smtpUsername: string
    fromName: string
    fromEmail: string
    smtpPassword: string | null
  }) {
    if (
      !input.smtpHost.trim()
      || !Number.isFinite(input.smtpPort)
      || input.smtpPort <= 0
      || !input.smtpUsername.trim()
      || !input.fromName.trim()
      || !input.fromEmail.trim()
    ) {
      throw apiBadRequest(API_ERROR_CODE.SYSTEM_EMAIL_CONFIG_INCOMPLETE)
    }

    if (!input.smtpPassword) {
      throw apiBadRequest(API_ERROR_CODE.SYSTEM_EMAIL_PASSWORD_MISSING)
    }
  }

  private async getTransportConfig(requireEnabled: boolean): Promise<{
    smtpHost: string
    smtpPort: number
    smtpSecure: boolean
    smtpUsername: string
    smtpPassword: string
    fromName: string
    fromEmail: string
  }> {
    const config = await this.prisma.systemEmailConfig.findFirst({
      orderBy: { updatedAt: 'desc' },
    })

    if (!config) {
      throw apiBadRequest(API_ERROR_CODE.SYSTEM_EMAIL_CONFIG_NOT_FOUND)
    }

    if (requireEnabled && !config.enabled) {
      throw apiBadRequest(API_ERROR_CODE.SYSTEM_EMAIL_DISABLED)
    }

    const smtpPassword = this.decryptPassword(config.smtpPasswordEncrypted)

    if (!smtpPassword) {
      throw apiBadRequest(API_ERROR_CODE.SYSTEM_EMAIL_PASSWORD_MISSING)
    }

    const normalizedFields = normalizeSystemEmailEditableFields({
      smtpHost: config.smtpHost,
      smtpUsername: config.smtpUsername,
      fromName: config.fromName,
      fromEmail: config.fromEmail,
    })

    if (
      !normalizedFields.smtpHost
      || !normalizedFields.smtpUsername
      || !normalizedFields.fromName
      || !normalizedFields.fromEmail
      || !Number.isFinite(config.smtpPort)
      || config.smtpPort <= 0
    ) {
      throw apiBadRequest(API_ERROR_CODE.SYSTEM_EMAIL_CONFIG_INCOMPLETE)
    }

    return {
      smtpHost: normalizedFields.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      smtpUsername: normalizedFields.smtpUsername,
      smtpPassword,
      fromName: normalizedFields.fromName,
      fromEmail: normalizedFields.fromEmail,
    }
  }

  private decryptPassword(value: string | null | undefined): string | null {
    if (!value) {
      return null
    }

    if (!isEncryptedValue(value)) {
      return value
    }

    return decryptAes256Gcm(value, this.encryptionKey)
  }
}

function createSimpleEmailHtml(input: {
  title: string
  content: string
}) {
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.7;">',
    `<h2 style="margin:0 0 16px;">${input.title}</h2>`,
    `<p style="margin:0;">${input.content}</p>`,
    '</div>',
  ].join('')
}

function createTestEmailTemplate(language: ResolvedLanguagePreference) {
  if (language === LANGUAGE_PREFERENCE.ZH_CN) {
    return {
      subject: 'Lexora 发件配置测试',
      title: '发件配置已生效',
      content: '这是一封来自 Lexora 的测试邮件，说明当前系统发件配置可正常发送。',
    }
  }

  return {
    subject: 'Lexora email configuration test',
    title: 'Email configuration is active',
    content: 'This is a test email from Lexora. Your system email configuration can send mail.',
  }
}
