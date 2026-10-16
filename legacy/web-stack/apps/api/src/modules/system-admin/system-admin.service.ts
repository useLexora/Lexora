import type {
  GetSystemAdminAuditLogsQuery,
  GetSystemAdminUsersQuery,
  ResolvedLanguagePreference,
  SystemAdminAuditLogListResponse,
  SystemAdminAuditTargetType,
  SystemAdminOverview,
  SystemAdminUserDetail,
  SystemAdminUserListResponse,
  SystemAdminUserStatus,
  SystemAuthGovernance,
  SystemEmailConfig,
  SystemEmailServiceStatus,
  TestSystemEmailConfigRequest,
  TestSystemEmailConfigResponse,
  UpdateSystemAdminUserResponse,
  UpdateSystemAuthGovernanceRequest,
  UpdateSystemAuthInviteCodeRequest,
  UpdateSystemEmailConfigRequest,
  UpdateSystemEmailServiceStatusRequest,
} from '@haohaoxue/lexora-contracts'
import {
  SYSTEM_ADMIN_AUDIT_TARGET_TYPE,
  SYSTEM_ADMIN_USER_DETAIL_LIMIT,
  SYSTEM_ADMIN_USER_ROLE_FILTER,
} from '@haohaoxue/lexora-contracts'
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  DocumentStatus,
  Prisma,
  UserStatus,
} from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { resolveAuthMethods } from '../auth/auth-methods.utils'
import { SystemAuthService } from '../auth/system-auth.service'
import { SystemEmailService } from '../system-email/system-email.service'
import {
  toSystemAdminAuditLogItem,
  toSystemAdminUserDetail,
  toSystemAdminUserItem,
  toSystemAuthGovernance,
} from './system-admin.utils'

@Injectable()
export class SystemAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemAuthService: SystemAuthService,
    private readonly systemEmailService: SystemEmailService,
  ) {}

  async getOverview(): Promise<SystemAdminOverview> {
    const [
      totalUsers,
      activeUsers,
      docStats,
      authGovernance,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: UserStatus.ACTIVE } }),
      this.getDocumentStats(),
      this.systemAuthService.getGovernanceSnapshot(),
    ])

    return {
      totalUsers,
      activeUsers,
      disabledUsers: totalUsers - activeUsers,
      systemAdminCount: authGovernance.config.systemAdminUserId ? 1 : 0,
      ...docStats,
    }
  }

  async getUsers(query: GetSystemAdminUsersQuery): Promise<SystemAdminUserListResponse> {
    const governance = await this.systemAuthService.getGovernanceSnapshot()
    const systemAdminUserId = governance.config.systemAdminUserId
    const pageSize = query.pageSize
    const pageNo = query.pageNo
    const where = buildSystemAdminUserWhere(query, systemAdminUserId)
    const total = await this.prisma.user.count({ where })

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (pageNo - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        email: true,
        displayName: true,
        userCode: true,
        avatarUrl: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        localCredential: {
          select: {
            userId: true,
          },
        },
        oauthAccounts: {
          where: {
            deletedAt: null,
          },
          select: {
            provider: true,
          },
        },
      },
    })

    return {
      total,
      items: users.map(user => toSystemAdminUserItem({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        userCode: user.userCode,
        avatarUrl: user.avatarUrl,
        status: user.status,
        isSystemAdmin: user.id === systemAdminUserId,
        authMethods: resolveAuthMethods(Boolean(user.localCredential), user.oauthAccounts),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })),
    }
  }

  async getUserDetail(userId: string): Promise<SystemAdminUserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })

    if (!user) {
      throw new NotFoundException(`User "${userId}" not found`)
    }

    const documentWhere = {
      createdBy: userId,
      trashedAt: null,
    } satisfies Prisma.DocumentWhereInput
    const chatSessionWhere = {
      createdBy: userId,
      deletedAt: null,
    } satisfies Prisma.ChatSessionWhereInput
    const [
      documentTotal,
      chatSessionTotal,
      documents,
      chatSessions,
    ] = await Promise.all([
      this.prisma.document.count({ where: documentWhere }),
      this.prisma.chatSession.count({ where: chatSessionWhere }),
      this.prisma.document.findMany({
        where: documentWhere,
        orderBy: { updatedAt: 'desc' },
        take: SYSTEM_ADMIN_USER_DETAIL_LIMIT,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.chatSession.findMany({
        where: chatSessionWhere,
        orderBy: { updatedAt: 'desc' },
        take: SYSTEM_ADMIN_USER_DETAIL_LIMIT,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ])

    return toSystemAdminUserDetail({
      documentTotal,
      chatSessionTotal,
      documents,
      chatSessions,
    })
  }

  async updateUserStatus(
    actorUserId: string,
    userId: string,
    status: SystemAdminUserStatus,
  ): Promise<UpdateSystemAdminUserResponse> {
    const isSystemAdmin = await this.systemAuthService.isSystemAdminUser(userId)

    if (isSystemAdmin && status === UserStatus.DISABLED) {
      throw new BadRequestException('不能禁用系统管理员')
    }

    if (actorUserId === userId && status === UserStatus.DISABLED) {
      throw new BadRequestException('不能禁用当前系统管理员自己')
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { status: status as UserStatus },
      select: {
        id: true,
        status: true,
      },
    }).catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException(`User "${userId}" not found`)
      }
      throw error
    })

    await this.createAuditLog(actorUserId, {
      action: 'user.status.updated',
      targetType: 'user',
      targetId: userId,
      metadata: { status },
    })

    return {
      id: user.id,
      status: user.status as SystemAdminUserStatus,
      isSystemAdmin,
    }
  }

  async getAuthGovernance(): Promise<SystemAuthGovernance> {
    const [snapshot, emailServiceEnabled] = await Promise.all([
      this.systemAuthService.getGovernanceSnapshot(),
      this.systemEmailService.isEnabled(),
    ])

    return toSystemAuthGovernance({
      allowPasswordRegistration: snapshot.config.allowPasswordRegistration,
      requirePasswordInviteCode: snapshot.config.requirePasswordInviteCode,
      oauthProviders: snapshot.registrationOptions.oauthProviders,
      hasRegistrationInviteCode: Boolean(snapshot.config.registrationInviteCodeHash),
      registrationInviteCode: snapshot.registrationInviteCode,
      emailServiceEnabled,
      systemAdminEmail: snapshot.config.systemAdminEmail,
      systemAdminDisplayName: snapshot.systemAdminUser?.displayName ?? null,
      systemAdminMustChangePassword: snapshot.localCredential?.mustChangePassword ?? false,
      systemAdminLastLoginAt: snapshot.systemAdminUser?.lastLoginAt ?? null,
      systemAdminPasswordUpdatedAt: snapshot.localCredential?.passwordUpdatedAt ?? null,
    })
  }

  async updateAuthGovernance(
    actorUserId: string,
    payload: UpdateSystemAuthGovernanceRequest,
  ): Promise<SystemAuthGovernance> {
    const nextRegistrationOptions = Object.fromEntries(
      Object.entries({
        allowPasswordRegistration: payload.allowPasswordRegistration,
        requirePasswordInviteCode: payload.requirePasswordInviteCode,
        oauthProviders: payload.oauthProviders,
      }).filter(([, value]) => value !== undefined),
    ) as UpdateSystemAuthGovernanceRequest

    if (Object.keys(nextRegistrationOptions).length === 0) {
      throw new BadRequestException('至少更新一项认证注册配置')
    }

    await this.systemAuthService.updateRegistrationOptions(actorUserId, nextRegistrationOptions)

    await this.createAuditLog(actorUserId, {
      action: 'system_auth_governance.updated',
      targetType: 'system_auth_config',
      targetId: 'default',
      metadata: nextRegistrationOptions as unknown as Prisma.InputJsonValue,
    })

    return this.getAuthGovernance()
  }

  async updateAuthInviteCode(
    actorUserId: string,
    payload: UpdateSystemAuthInviteCodeRequest,
  ): Promise<SystemAuthGovernance> {
    await this.systemAuthService.updateRegistrationInviteCode(actorUserId, payload.inviteCode)
    const isClearing = payload.inviteCode.trim().length === 0

    await this.createAuditLog(actorUserId, {
      action: isClearing
        ? 'system_auth_governance.invite_code.cleared'
        : 'system_auth_governance.invite_code.updated',
      targetType: 'system_auth_config',
      targetId: 'default',
      metadata: isClearing ? { cleared: true } : { updated: true },
    })

    return this.getAuthGovernance()
  }

  async getEmailConfig(): Promise<SystemEmailConfig> {
    const [config, lastTest] = await Promise.all([
      this.systemEmailService.getEmailConfig(),
      this.getLatestEmailTestResult(),
    ])

    return {
      ...config,
      lastTest,
    }
  }

  async getEmailServiceStatus(): Promise<SystemEmailServiceStatus> {
    return this.systemEmailService.getEmailServiceStatus()
  }

  async updateEmailConfig(
    actorUserId: string,
    payload: UpdateSystemEmailConfigRequest,
  ): Promise<SystemEmailConfig> {
    const result = await this.systemEmailService.updateEmailConfig(actorUserId, payload)
    const lastTest = await this.getLatestEmailTestResult()

    await this.createAuditLog(actorUserId, {
      action: 'system_email_config.updated',
      targetType: 'system_email_config',
      targetId: 'default',
      metadata: {
        provider: payload.provider,
        smtpHost: payload.smtpHost,
        smtpPort: payload.smtpPort,
        smtpSecure: payload.smtpSecure,
        smtpUsername: payload.smtpUsername,
        fromName: payload.fromName,
        fromEmail: payload.fromEmail,
        hasPassword: result.hasPassword,
        clearPassword: payload.clearPassword ?? false,
      },
    })

    return {
      ...result,
      lastTest,
    }
  }

  async updateEmailServiceStatus(
    actorUserId: string,
    payload: UpdateSystemEmailServiceStatusRequest,
  ): Promise<SystemEmailServiceStatus> {
    const result = await this.systemEmailService.updateEmailServiceStatus(actorUserId, payload)

    await this.createAuditLog(actorUserId, {
      action: 'system_email_service.updated',
      targetType: 'system_email_service',
      targetId: 'default',
      metadata: {
        enabled: payload.enabled,
      },
    })

    return result
  }

  async testEmailConfig(
    actorUserId: string,
    payload: TestSystemEmailConfigRequest,
    language?: ResolvedLanguagePreference,
  ): Promise<TestSystemEmailConfigResponse> {
    try {
      const result = await this.systemEmailService.sendTestEmail(payload.email, language)

      await this.createAuditLog(actorUserId, {
        action: 'system_email_config.tested',
        targetType: 'system_email_config',
        targetId: 'default',
        metadata: {
          recipientEmail: payload.email,
          succeeded: true,
          message: null,
        },
      })

      return result
    }
    catch (error) {
      await this.createAuditLog(actorUserId, {
        action: 'system_email_config.tested',
        targetType: 'system_email_config',
        targetId: 'default',
        metadata: {
          recipientEmail: payload.email,
          succeeded: false,
          message: getErrorMessage(error),
        },
      })

      throw error
    }
  }

  async getAuditLogs(query: GetSystemAdminAuditLogsQuery): Promise<SystemAdminAuditLogListResponse> {
    const where = buildSystemAdminAuditLogWhere(query)
    const total = await this.prisma.adminAuditLog.count({ where })
    const logs = await this.prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.pageNo - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        actorUser: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    })

    return {
      total,
      items: logs.map(log => toSystemAdminAuditLogItem({
        id: log.id,
        action: log.action,
        targetType: log.targetType as SystemAdminAuditTargetType,
        targetId: log.targetId,
        actorUserId: log.actorUser.id,
        actorDisplayName: log.actorUser.displayName,
        actorAvatarUrl: log.actorUser.avatarUrl,
        metadata: asRecord(log.metadata),
        createdAt: log.createdAt,
      })),
    }
  }

  private async getDocumentStats() {
    const [totalDocuments, singlePublishedDocuments, sitePublishedPages, lockedDocuments] = await Promise.all([
      this.prisma.document.count(),
      this.prisma.documentSinglePublicationSetting.count({ where: { state: 'ENABLED' } }),
      this.prisma.documentPublicationPage.count({ where: { status: 'ACTIVE' } }),
      this.prisma.document.count({ where: { status: DocumentStatus.LOCKED } }),
    ])

    return {
      totalDocuments,
      publishedDocuments: singlePublishedDocuments + sitePublishedPages,
      lockedDocuments,
    }
  }

  private async getLatestEmailTestResult(): Promise<SystemEmailConfig['lastTest']> {
    const latestTestLog = await this.prisma.adminAuditLog.findFirst({
      where: {
        action: 'system_email_config.tested',
        targetType: SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_EMAIL_CONFIG,
      },
      orderBy: { createdAt: 'desc' },
    })

    const metadata = latestTestLog ? asRecord(latestTestLog.metadata) : null

    if (!latestTestLog || typeof metadata?.recipientEmail !== 'string' || typeof metadata.succeeded !== 'boolean') {
      return null
    }

    return {
      testedAt: latestTestLog.createdAt.toISOString(),
      recipientEmail: metadata.recipientEmail,
      succeeded: metadata.succeeded,
      message: typeof metadata.message === 'string' && metadata.message.trim()
        ? metadata.message.trim()
        : null,
    }
  }

  private async createAuditLog(
    actorUserId: string,
    input: {
      action: string
      targetType: string
      targetId: string | null
      metadata?: Prisma.InputJsonValue
    },
  ) {
    await this.prisma.adminAuditLog.create({
      data: {
        actorUserId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: input.metadata,
      },
    })
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 300)
  }

  return '测试邮件发送失败'
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function buildSystemAdminUserWhere(
  query: GetSystemAdminUsersQuery,
  systemAdminUserId: string | null,
): Prisma.UserWhereInput {
  const keyword = query.keyword?.trim()

  return {
    ...(keyword
      ? {
          OR: [
            {
              displayName: {
                contains: keyword,
                mode: 'insensitive',
              },
            },
            {
              email: {
                contains: keyword,
                mode: 'insensitive',
              },
            },
            {
              userCode: {
                contains: keyword,
                mode: 'insensitive',
              },
            },
          ],
        }
      : {}),
    ...(query.status ? { status: query.status as UserStatus } : {}),
    ...(query.role === SYSTEM_ADMIN_USER_ROLE_FILTER.SYSTEM_ADMIN
      ? {
          id: systemAdminUserId ?? '__missing_system_admin__',
        }
      : {}),
    ...(query.role === SYSTEM_ADMIN_USER_ROLE_FILTER.REGULAR_USER && systemAdminUserId
      ? {
          NOT: {
            id: systemAdminUserId,
          },
        }
      : {}),
  }
}

function buildSystemAdminAuditLogWhere(query: GetSystemAdminAuditLogsQuery): Prisma.AdminAuditLogWhereInput {
  return {
    ...(query.targetType ? { targetType: query.targetType } : {}),
    targetType: {
      in: [
        SYSTEM_ADMIN_AUDIT_TARGET_TYPE.USER,
        SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_AUTH_CONFIG,
        SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_EMAIL_CONFIG,
        SYSTEM_ADMIN_AUDIT_TARGET_TYPE.SYSTEM_EMAIL_SERVICE,
      ],
      ...(query.targetType ? { equals: query.targetType } : {}),
    },
  }
}
