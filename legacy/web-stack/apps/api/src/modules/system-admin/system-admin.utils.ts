import type {
  AuthMethodName,
  AuthProviderName,
  SystemAdminAuditLogItem,
  SystemAdminAuditTargetType,
  SystemAdminUserChatSessionItem,
  SystemAdminUserDetail,
  SystemAdminUserDocumentItem,
  SystemAdminUserItem,
  SystemAdminUserStatus,
  SystemAuthGovernance,
  SystemAuthProviderGovernance,
} from '@haohaoxue/lexora-contracts'

export interface SystemAdminUserItemRecord {
  id: string
  email: string | null
  displayName: string
  userCode: string
  avatarUrl: string | null
  status: SystemAdminUserStatus
  isSystemAdmin: boolean
  authMethods: AuthMethodName[]
  createdAt: Date
  updatedAt: Date
}

export interface SystemAdminUserDocumentItemRecord {
  id: string
  title: string
  createdAt: Date
  updatedAt: Date
}

export interface SystemAdminUserChatSessionItemRecord {
  id: string
  title: string
  createdAt: Date
  updatedAt: Date
}

export interface SystemAuthGovernanceRecord {
  allowPasswordRegistration: boolean
  requirePasswordInviteCode: boolean
  oauthProviders: Record<AuthProviderName, SystemAuthProviderGovernance>
  hasRegistrationInviteCode: boolean
  registrationInviteCode: string | null
  emailServiceEnabled: boolean
  systemAdminEmail: string
  systemAdminDisplayName: string | null
  systemAdminMustChangePassword: boolean
  systemAdminLastLoginAt: Date | null
  systemAdminPasswordUpdatedAt: Date | null
}

export interface SystemAdminAuditLogItemRecord {
  id: string
  action: string
  targetType: SystemAdminAuditTargetType
  targetId: string | null
  actorUserId: string
  actorDisplayName: string
  actorAvatarUrl: string | null
  metadata: Record<string, unknown> | null
  createdAt: Date
}

export function toSystemAdminUserItem(record: SystemAdminUserItemRecord): SystemAdminUserItem {
  return {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    userCode: record.userCode,
    avatarUrl: record.avatarUrl,
    status: record.status,
    isSystemAdmin: record.isSystemAdmin,
    authMethods: record.authMethods,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export function toSystemAdminUserDetail(record: {
  documentTotal: number
  chatSessionTotal: number
  documents: SystemAdminUserDocumentItemRecord[]
  chatSessions: SystemAdminUserChatSessionItemRecord[]
}): SystemAdminUserDetail {
  return {
    documentTotal: record.documentTotal,
    chatSessionTotal: record.chatSessionTotal,
    documents: record.documents.map(toSystemAdminUserDocumentItem),
    chatSessions: record.chatSessions.map(toSystemAdminUserChatSessionItem),
  }
}

function toSystemAdminUserDocumentItem(record: SystemAdminUserDocumentItemRecord): SystemAdminUserDocumentItem {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function toSystemAdminUserChatSessionItem(record: SystemAdminUserChatSessionItemRecord): SystemAdminUserChatSessionItem {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export function toSystemAuthGovernance(record: SystemAuthGovernanceRecord): SystemAuthGovernance {
  return {
    allowPasswordRegistration: record.allowPasswordRegistration,
    requirePasswordInviteCode: record.requirePasswordInviteCode,
    oauthProviders: record.oauthProviders,
    hasRegistrationInviteCode: record.hasRegistrationInviteCode,
    registrationInviteCode: record.registrationInviteCode,
    emailServiceEnabled: record.emailServiceEnabled,
    systemAdminEmail: record.systemAdminEmail,
    systemAdminDisplayName: record.systemAdminDisplayName,
    systemAdminMustChangePassword: record.systemAdminMustChangePassword,
    systemAdminLastLoginAt: toIsoDateTimeString(record.systemAdminLastLoginAt),
    systemAdminPasswordUpdatedAt: toIsoDateTimeString(record.systemAdminPasswordUpdatedAt),
  }
}

export function toSystemAdminAuditLogItem(record: SystemAdminAuditLogItemRecord): SystemAdminAuditLogItem {
  return {
    id: record.id,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    actorUserId: record.actorUserId,
    actorDisplayName: record.actorDisplayName,
    actorAvatarUrl: record.actorAvatarUrl,
    metadata: record.metadata,
    createdAt: record.createdAt.toISOString(),
  }
}

function toIsoDateTimeString(value: Date | null): string | null {
  return value?.toISOString() ?? null
}
