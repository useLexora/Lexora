import type {
  AuditUserSummary,
  SystemEmailConfig,
  SystemEmailProvider,
  SystemEmailServiceStatus,
} from '@haohaoxue/lexora-contracts'
import {
  SYSTEM_EMAIL_PROVIDER,
  SYSTEM_EMAIL_PROVIDER_DEFAULTS,
} from '@haohaoxue/lexora-contracts'

export interface SystemEmailConfigRecord {
  provider: SystemEmailProvider
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUsername: string
  fromName: string
  fromEmail: string
  updatedAt: Date | null
  updatedBy: string | null
  updatedByUser: AuditUserSummary | null
}

export interface SystemEmailServiceStatusRecord {
  enabled: boolean
}

export function createDefaultSystemEmailConfig(): SystemEmailConfig {
  const provider = SYSTEM_EMAIL_PROVIDER.TENCENT_EXMAIL
  const defaults = SYSTEM_EMAIL_PROVIDER_DEFAULTS[provider]

  return {
    provider,
    smtpHost: defaults.smtpHost,
    smtpPort: defaults.smtpPort,
    smtpSecure: defaults.smtpSecure,
    smtpUsername: '',
    fromName: 'Lexora',
    fromEmail: '',
    hasPassword: false,
    lastTest: null,
    updatedAt: null,
    updatedBy: null,
    updatedByUser: null,
  }
}

export function toSystemEmailConfig(
  record: SystemEmailConfigRecord,
  hasPassword: boolean,
): SystemEmailConfig {
  return {
    provider: record.provider,
    smtpHost: record.smtpHost,
    smtpPort: record.smtpPort,
    smtpSecure: record.smtpSecure,
    smtpUsername: record.smtpUsername,
    fromName: record.fromName,
    fromEmail: record.fromEmail,
    hasPassword,
    lastTest: null,
    updatedAt: toIsoDateTimeString(record.updatedAt),
    updatedBy: record.updatedBy,
    updatedByUser: record.updatedByUser,
  }
}

export function toSystemEmailServiceStatus(
  record: SystemEmailServiceStatusRecord | null | undefined,
): SystemEmailServiceStatus {
  return {
    enabled: record?.enabled ?? false,
  }
}

export function normalizeSystemEmailEditableFields(input: {
  smtpHost: string
  smtpUsername: string
  fromName: string
  fromEmail: string
}): {
  smtpHost: string
  smtpUsername: string
  fromName: string
  fromEmail: string
} {
  return {
    smtpHost: input.smtpHost.trim(),
    smtpUsername: input.smtpUsername.trim(),
    fromName: input.fromName.trim(),
    fromEmail: input.fromEmail.trim().toLowerCase(),
  }
}

function toIsoDateTimeString(value: Date | null): string | null {
  return value?.toISOString() ?? null
}
