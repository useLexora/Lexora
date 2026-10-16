import type { AuthMethodName, AuthProviderName } from '@haohaoxue/lexora-contracts'
import type { LocalCredential, SystemAuthConfig, User } from '@prisma/client'
import type { BootstrapConfig, CryptoConfig } from '../../config/auth.config'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { AUTH_METHOD, AUTH_PROVIDER, AUTH_PROVIDER_VALUES } from '@haohaoxue/lexora-contracts'
import { formatAuthMethod } from '@haohaoxue/lexora-shared'
import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { StorageService } from '../../infrastructure/storage/storage.service'
import { decryptAes256Gcm, encryptAes256Gcm } from '../../utils/crypto'
import { RbacService } from '../rbac/rbac.service'
import { SystemEmailService } from '../system-email/system-email.service'
import { AVATAR_BUCKET } from '../users/users.constants'
import {
  buildAvatarUrl,
  resolveUniqueUserCode,
} from '../users/users.utils'
import { PersonalWorkspacesService } from '../workspaces/personal-workspaces.service'
import { hashPassword, verifyPassword } from './password.utils'
import { generateSystemAdminInitialPassword } from './system-admin-password.utils'

const SYSTEM_AUTH_CONFIG_ID = 'default'
const SYSTEM_ADMIN_DISPLAY_NAME = 'Lexora'
const SYSTEM_ADMIN_AVATAR_FILE_NAME = 'system-admin-avatar.png'
const SYSTEM_ADMIN_AVATAR_CONTENT_TYPE = 'image/png'

export interface RegistrationOptions {
  allowPasswordRegistration: boolean
  requirePasswordInviteCode: boolean
  oauthProviders: Record<AuthProviderName, OAuthProviderRegistrationOptions>
  registrationInviteCodeHash: string | null
}

export interface OAuthProviderRegistrationOptions {
  allowLogin: boolean
  allowRegistration: boolean
  requireInviteCode: boolean
}

export type RegistrationOptionsUpdate
  = & Partial<Pick<RegistrationOptions, 'allowPasswordRegistration' | 'requirePasswordInviteCode'>>
    & {
      oauthProviders?: Partial<Record<AuthProviderName, Partial<OAuthProviderRegistrationOptions>>>
    }

const DEFAULT_OAUTH_PROVIDER_REGISTRATION_OPTIONS = {
  allowLogin: true,
  allowRegistration: true,
  requireInviteCode: false,
} as const satisfies OAuthProviderRegistrationOptions

@Injectable()
export class SystemAuthService implements OnModuleInit {
  private readonly logger = new Logger(SystemAuthService.name)
  private readonly bootstrapConfig: BootstrapConfig
  private readonly encryptionKey: string

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbacService: RbacService,
    private readonly systemEmailService: SystemEmailService,
    private readonly personalWorkspacesService: PersonalWorkspacesService,
    configService: ConfigService,
    private readonly storageService: StorageService,
  ) {
    this.bootstrapConfig = configService.getOrThrow<BootstrapConfig>('bootstrap')
    this.encryptionKey = configService.getOrThrow<CryptoConfig>('crypto').encryptionKey
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSystemAdminBootstrap()
  }

  async ensureSystemAdminBootstrap(): Promise<void> {
    const config = await this.getOrCreateConfig()
    const systemAdminEmail = this.bootstrapConfig.systemAdminEmail
    const existingSystemAdminUserId = config.systemAdminUserId
    const user = await this.ensureSystemAdminUser(systemAdminEmail)
    const localCredential = await this.ensureSystemAdminCredential(user.id)
    await this.ensureSystemAdminAvatar(user)

    await this.prisma.systemAuthConfig.update({
      where: { id: SYSTEM_AUTH_CONFIG_ID },
      data: {
        systemAdminEmail,
        systemAdminUserId: user.id,
      },
    })

    await this.rbacService.ensureDefaultUserRole(user.id)
    await this.rbacService.enforceSystemAdminRole(user.id)

    if (localCredential.createdInitialPassword) {
      this.logger.log(`System admin initialized: ${systemAdminEmail}`)
      this.logger.warn(`System admin initial password: ${localCredential.initialPassword}`)
    }

    if (existingSystemAdminUserId && existingSystemAdminUserId !== user.id) {
      await this.rbacService.revokeSystemAdminRole(existingSystemAdminUserId)
    }
  }

  async getRegistrationOptions(): Promise<RegistrationOptions> {
    const config = await this.getOrCreateConfig()

    return {
      allowPasswordRegistration: config.allowPasswordRegistration,
      requirePasswordInviteCode: config.requirePasswordInviteCode,
      oauthProviders: resolveOAuthProviderRegistrationOptions(config.oauthProviderOptions),
      registrationInviteCodeHash: config.registrationInviteCodeHash,
    }
  }

  async getGovernanceSnapshot(): Promise<{
    config: SystemAuthConfig
    registrationOptions: RegistrationOptions
    registrationInviteCode: string | null
    systemAdminUser: Pick<User, 'id' | 'email' | 'displayName' | 'lastLoginAt'> | null
    localCredential: Pick<LocalCredential, 'mustChangePassword' | 'passwordUpdatedAt'> | null
  }> {
    const config = await this.getOrCreateConfig()
    const systemAdminUser = config.systemAdminUserId
      ? await this.prisma.user.findUnique({
          where: { id: config.systemAdminUserId },
          select: {
            id: true,
            email: true,
            displayName: true,
            lastLoginAt: true,
          },
        })
      : null

    const localCredential = config.systemAdminUserId
      ? await this.prisma.localCredential.findUnique({
          where: { userId: config.systemAdminUserId },
          select: {
            mustChangePassword: true,
            passwordUpdatedAt: true,
          },
        })
      : null

    return {
      config,
      registrationOptions: {
        allowPasswordRegistration: config.allowPasswordRegistration,
        requirePasswordInviteCode: config.requirePasswordInviteCode,
        oauthProviders: resolveOAuthProviderRegistrationOptions(config.oauthProviderOptions),
        registrationInviteCodeHash: config.registrationInviteCodeHash,
      },
      registrationInviteCode: this.decryptRegistrationInviteCode(config.registrationInviteCodeEncrypted),
      systemAdminUser,
      localCredential,
    }
  }

  async updateRegistrationOptions(
    updatedBy: string,
    payload: RegistrationOptionsUpdate,
  ): Promise<SystemAuthConfig> {
    const config = await this.getOrCreateConfig()
    const { oauthProviders, ...restPayload } = payload
    const nextOauthProviderOptions = oauthProviders
      ? mergeOAuthProviderRegistrationOptions(config.oauthProviderOptions, oauthProviders)
      : undefined

    return this.prisma.systemAuthConfig.update({
      where: { id: SYSTEM_AUTH_CONFIG_ID },
      data: {
        ...restPayload,
        ...(nextOauthProviderOptions
          ? { oauthProviderOptions: nextOauthProviderOptions as unknown as Prisma.InputJsonValue }
          : {}),
        updatedBy,
      },
    })
  }

  async updateRegistrationInviteCode(
    updatedBy: string,
    inviteCode: string,
  ): Promise<SystemAuthConfig> {
    await this.getOrCreateConfig()
    const normalizedInviteCode = normalizeRegistrationInviteCode(inviteCode)

    if (!normalizedInviteCode) {
      return this.prisma.systemAuthConfig.update({
        where: { id: SYSTEM_AUTH_CONFIG_ID },
        data: {
          registrationInviteCodeHash: null,
          registrationInviteCodeEncrypted: null,
          updatedBy,
        },
      })
    }

    if (normalizedInviteCode.length < 4) {
      throw new BadRequestException('邀请码至少 4 位')
    }

    return this.prisma.systemAuthConfig.update({
      where: { id: SYSTEM_AUTH_CONFIG_ID },
      data: {
        registrationInviteCodeHash: await hashPassword(normalizedInviteCode),
        registrationInviteCodeEncrypted: encryptAes256Gcm(normalizedInviteCode, this.encryptionKey),
        updatedBy,
      },
    })
  }

  async assertOauthProviderLoginAllowed(method: AuthMethodName): Promise<void> {
    const options = await this.getRegistrationOptions()
    const provider = resolveProviderFromAuthMethod(method)

    if (provider && !options.oauthProviders[provider].allowLogin) {
      throw new BadRequestException(`当前未开放 ${formatAuthMethod(method)} 登录`)
    }
  }

  async assertRegistrationAllowed(method: AuthMethodName): Promise<void> {
    const options = await this.getRegistrationOptions()

    if (method === AUTH_METHOD.PASSWORD) {
      if (!options.allowPasswordRegistration || !(await this.systemEmailService.isEnabled())) {
        throw new BadRequestException('当前未开放邮箱密码注册')
      }

      return
    }

    const provider = resolveProviderFromAuthMethod(method)

    if (provider && !options.oauthProviders[provider].allowRegistration) {
      throw new BadRequestException(`当前未开放 ${formatAuthMethod(method)} 注册`)
    }
  }

  async isRegistrationInviteCodeRequired(method: AuthMethodName): Promise<boolean> {
    const options = await this.getRegistrationOptions()
    return isRegistrationInviteCodeRequired(method, options)
  }

  async assertRegistrationInviteCode(method: AuthMethodName, inviteCode: string): Promise<void> {
    const options = await this.getRegistrationOptions()

    if (!isRegistrationInviteCodeRequired(method, options)) {
      throw new BadRequestException('当前注册方式不需要邀请码')
    }

    if (!options.registrationInviteCodeHash) {
      throw new BadRequestException('当前注册邀请码未设置')
    }

    if (!(await verifyPassword(normalizeRegistrationInviteCode(inviteCode), options.registrationInviteCodeHash))) {
      throw new BadRequestException('邀请码无效或已变更')
    }
  }

  private decryptRegistrationInviteCode(value: string | null | undefined): string | null {
    if (!value) {
      return null
    }

    return decryptAes256Gcm(value, this.encryptionKey)
  }

  async isSystemAdminUser(userId: string): Promise<boolean> {
    const config = await this.getOrCreateConfig()
    return config.systemAdminUserId === userId
  }

  private async ensureSystemAdminUser(email: string): Promise<User> {
    const normalizedEmail = email.trim().toLowerCase()
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    })

    if (existingUser) {
      const user = await this.prisma.user.update({
        where: { id: existingUser.id },
        data: {
          email: normalizedEmail,
          status: 'ACTIVE',
          displayName: SYSTEM_ADMIN_DISPLAY_NAME,
        },
      })

      await this.personalWorkspacesService.provisionPersonalWorkspaceForUser({
        userId: user.id,
        userCode: user.userCode,
      })

      return user
    }

    return this.prisma.$transaction(async (tx) => {
      const userCode = await resolveUniqueUserCode({
        isUserCodeTaken: async candidate =>
          Boolean(await tx.user.findUnique({
            where: { userCode: candidate },
            select: { id: true },
          })),
      })

      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          displayName: SYSTEM_ADMIN_DISPLAY_NAME,
          status: 'ACTIVE',
          userCode,
        },
      })

      await this.personalWorkspacesService.provisionPersonalWorkspaceForUser({
        userId: user.id,
        userCode: user.userCode,
      }, tx)

      return user
    })
  }

  private async ensureSystemAdminAvatar(user: User): Promise<void> {
    const avatarStorageKey = buildSystemAdminAvatarStorageKey(user.id)
    const avatarUrl = buildAvatarUrl(user.id)
    const avatarBuffer = await readFile(resolveSystemAdminAvatarPath())

    await this.storageService.putObject({
      bucket: AVATAR_BUCKET,
      key: avatarStorageKey,
      body: avatarBuffer,
      contentType: SYSTEM_ADMIN_AVATAR_CONTENT_TYPE,
      contentDisposition: {
        type: 'inline',
        fileName: SYSTEM_ADMIN_AVATAR_FILE_NAME,
        fallbackFileName: 'avatar',
      },
      contentLength: avatarBuffer.length,
      cacheControl: 'public, max-age=300',
    })

    if (user.avatarStorageKey !== avatarStorageKey || !user.avatarUrl) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          displayName: SYSTEM_ADMIN_DISPLAY_NAME,
          avatarUrl,
          avatarStorageKey,
        },
      })
    }

    if (user.avatarStorageKey && user.avatarStorageKey !== avatarStorageKey) {
      await this.storageService.deleteObject({
        bucket: AVATAR_BUCKET,
        key: user.avatarStorageKey,
      })
    }
  }

  private async ensureSystemAdminCredential(userId: string): Promise<{ createdInitialPassword: boolean, initialPassword?: string }> {
    const credential = await this.prisma.localCredential.findUnique({
      where: { userId },
      select: {
        userId: true,
        emailVerifiedAt: true,
      },
    })

    if (credential) {
      if (!credential.emailVerifiedAt) {
        await this.prisma.localCredential.update({
          where: { userId },
          data: {
            emailVerifiedAt: new Date(),
          },
        })
      }

      return { createdInitialPassword: false }
    }

    const initialPassword = generateSystemAdminInitialPassword()
    const passwordHash = await hashPassword(initialPassword)

    await this.prisma.localCredential.create({
      data: {
        userId,
        passwordHash,
        mustChangePassword: true,
        emailVerifiedAt: new Date(),
        passwordUpdatedAt: new Date(),
      },
    })

    return {
      createdInitialPassword: true,
      initialPassword,
    }
  }

  private async getOrCreateConfig(): Promise<SystemAuthConfig> {
    const existing = await this.prisma.systemAuthConfig.findUnique({
      where: { id: SYSTEM_AUTH_CONFIG_ID },
    })

    if (existing) {
      return existing
    }

    try {
      return await this.prisma.systemAuthConfig.create({
        data: {
          id: SYSTEM_AUTH_CONFIG_ID,
          systemAdminEmail: this.bootstrapConfig.systemAdminEmail,
        },
      })
    }
    catch {
      return this.prisma.systemAuthConfig.findUniqueOrThrow({
        where: { id: SYSTEM_AUTH_CONFIG_ID },
      })
    }
  }
}

function buildSystemAdminAvatarStorageKey(userId: string): string {
  return `user-avatar/${userId}/system-admin-brand.png`
}

function resolveSystemAdminAvatarPath(): string {
  return join(process.cwd(), 'assets', SYSTEM_ADMIN_AVATAR_FILE_NAME)
}

function isRegistrationInviteCodeRequired(
  method: AuthMethodName,
  options: RegistrationOptions,
): boolean {
  if (method === AUTH_METHOD.PASSWORD) {
    return options.requirePasswordInviteCode
  }

  const provider = resolveProviderFromAuthMethod(method)
  return provider ? options.oauthProviders[provider].requireInviteCode : false
}

function normalizeRegistrationInviteCode(inviteCode: string): string {
  return inviteCode.trim()
}

function resolveProviderFromAuthMethod(method: AuthMethodName): AuthProviderName | null {
  if (method === AUTH_METHOD.GOOGLE) {
    return AUTH_PROVIDER.GOOGLE
  }

  if (method === AUTH_METHOD.GITHUB) {
    return AUTH_PROVIDER.GITHUB
  }

  if (method === AUTH_METHOD.LINUX_DO) {
    return AUTH_PROVIDER.LINUX_DO
  }

  return null
}

function resolveOAuthProviderRegistrationOptions(
  value: Prisma.JsonValue,
): Record<AuthProviderName, OAuthProviderRegistrationOptions> {
  const record = isPlainRecord(value) ? value : {}

  return Object.fromEntries(AUTH_PROVIDER_VALUES.map((provider) => {
    const options = isPlainRecord(record[provider]) ? record[provider] : {}

    return [provider, {
      allowLogin: typeof options.allowLogin === 'boolean'
        ? options.allowLogin
        : DEFAULT_OAUTH_PROVIDER_REGISTRATION_OPTIONS.allowLogin,
      allowRegistration: typeof options.allowRegistration === 'boolean'
        ? options.allowRegistration
        : DEFAULT_OAUTH_PROVIDER_REGISTRATION_OPTIONS.allowRegistration,
      requireInviteCode: typeof options.requireInviteCode === 'boolean'
        ? options.requireInviteCode
        : DEFAULT_OAUTH_PROVIDER_REGISTRATION_OPTIONS.requireInviteCode,
    }]
  })) as Record<AuthProviderName, OAuthProviderRegistrationOptions>
}

function mergeOAuthProviderRegistrationOptions(
  currentValue: Prisma.JsonValue,
  patch: Partial<Record<AuthProviderName, Partial<OAuthProviderRegistrationOptions>>>,
): Record<AuthProviderName, OAuthProviderRegistrationOptions> {
  const current = resolveOAuthProviderRegistrationOptions(currentValue)

  return Object.fromEntries(AUTH_PROVIDER_VALUES.map((provider) => {
    const nextPatch = patch[provider]

    return [provider, {
      ...current[provider],
      ...(nextPatch?.allowLogin !== undefined ? { allowLogin: nextPatch.allowLogin } : {}),
      ...(nextPatch?.allowRegistration !== undefined ? { allowRegistration: nextPatch.allowRegistration } : {}),
      ...(nextPatch?.requireInviteCode !== undefined ? { requireInviteCode: nextPatch.requireInviteCode } : {}),
    }]
  })) as Record<AuthProviderName, OAuthProviderRegistrationOptions>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
