import type {
  DeleteCurrentUserRequest,
  PermissionCode,
  SessionUser,
  UpdateUserPreferencesRequest,
  UserSettings,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../auth/auth.interface'
import { AUTH_PROVIDER, AUTH_PROVIDER_VALUES, ROLES } from '@haohaoxue/lexora-contracts'
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { AuthProvider } from '@prisma/client'
import { PrismaService } from '../../database/prisma.service'
import { resolveAuthMethods } from '../auth/auth-methods.utils'
import { RbacService } from '../rbac/rbac.service'
import { UserAvatarsService } from './user-avatars.service'
import {
  mapAppearancePreference,
  mapAppearancePreferenceToDb,
  mapLanguagePreference,
  mapLanguagePreferenceToDb,
  normalizeAccountDeletionConfirmation,
} from './users.utils'

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbacService: RbacService,
    private readonly userAvatarsService: UserAvatarsService,
  ) {}

  async getCurrentUser(userId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        userCode: true,
        localCredential: {
          select: {
            mustChangePassword: true,
            emailVerifiedAt: true,
          },
        },
        oauthAccounts: {
          where: {
            deletedAt: null,
          },
          select: {
            provider: true,
            providerEmailVerified: true,
          },
        },
      },
    })

    if (!user) {
      throw new NotFoundException(`User "${userId}" not found`)
    }

    const context = await this.rbacService.getUserRoleAndPermissions(userId)

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      userCode: user.userCode,
      roles: context.roles,
      permissions: context.permissions,
      authMethods: resolveAuthMethods(Boolean(user.localCredential), user.oauthAccounts),
      mustChangePassword: user.localCredential?.mustChangePassword ?? false,
      emailVerified: Boolean(user.localCredential?.emailVerifiedAt) || user.oauthAccounts.some(item => item.providerEmailVerified === true),
    }
  }

  async getCurrentUserSettings(userId: string): Promise<UserSettings> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        displayName: true,
        avatarUrl: true,
        userCode: true,
        localCredential: {
          select: {
            userId: true,
            emailVerifiedAt: true,
          },
        },
        preference: {
          select: {
            languagePreference: true,
            appearancePreference: true,
          },
        },
        oauthAccounts: {
          where: {
            deletedAt: null,
          },
          select: {
            provider: true,
            providerUsername: true,
          },
        },
      },
    })

    if (!user) {
      throw new NotFoundException(`User "${userId}" not found`)
    }

    return {
      profile: {
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
      account: {
        email: user.email,
        userCode: user.userCode,
        hasPasswordAuth: Boolean(user.localCredential),
        emailVerified: Boolean(user.localCredential?.emailVerifiedAt),
        oauthProviders: buildUserOauthBindings(user.oauthAccounts),
      },
      preferences: {
        language: mapLanguagePreference(user.preference?.languagePreference),
        appearance: mapAppearancePreference(user.preference?.appearancePreference),
      },
    }
  }

  async getCurrentUserPermissions(userId: string): Promise<PermissionCode[]> {
    const context = await this.rbacService.getUserRoleAndPermissions(userId)
    return context.permissions
  }

  async updateCurrentUserProfile(authUser: AuthUserContext, displayName: string): Promise<SessionUser> {
    if (authUser.roles.includes(ROLES.SYSTEM_ADMIN)) {
      throw new BadRequestException('系统管理员账号不支持修改显示名称')
    }

    const normalizedDisplayName = displayName.trim()

    if (!normalizedDisplayName.length) {
      throw new BadRequestException('显示名称不能为空')
    }

    await this.prisma.user.update({
      where: { id: authUser.id },
      data: {
        displayName: normalizedDisplayName,
      },
    })

    return this.getCurrentUser(authUser.id)
  }

  async deleteCurrentUser(
    authUser: AuthUserContext,
    payload: DeleteCurrentUserRequest,
  ): Promise<void> {
    if (authUser.roles.includes(ROLES.SYSTEM_ADMIN)) {
      throw new BadRequestException('系统管理员账号不支持在这里删除')
    }

    const currentUser = await this.prisma.$bypass.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarStorageKey: true,
      },
    })

    if (!currentUser) {
      throw new NotFoundException(`User "${authUser.id}" not found`)
    }

    const expectedConfirmation = currentUser.email ?? currentUser.displayName
    const normalizedAccountConfirmation = normalizeAccountDeletionConfirmation(payload.accountConfirmation, Boolean(currentUser.email))

    if (normalizedAccountConfirmation !== normalizeAccountDeletionConfirmation(expectedConfirmation, Boolean(currentUser.email))) {
      throw new BadRequestException(currentUser.email ? '请输入当前邮箱完成确认' : '请输入当前显示名称完成确认')
    }

    await this.prisma.$bypass.$transaction(async (tx) => {
      await tx.authOauthState.deleteMany({
        where: {
          initiatorUserId: authUser.id,
        },
      })

      await tx.user.delete({
        where: {
          id: authUser.id,
        },
      })
    })

    await this.userAvatarsService.removeAvatarObject(currentUser.avatarStorageKey)
  }

  async updatePreferences(
    userId: string,
    payload: UpdateUserPreferencesRequest,
  ): Promise<UserSettings['preferences']> {
    if (payload.language === undefined && payload.appearance === undefined) {
      throw new BadRequestException('至少更新一项偏好设置')
    }

    const currentUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        preference: {
          select: {
            languagePreference: true,
            appearancePreference: true,
          },
        },
      },
    })

    if (!currentUser) {
      throw new NotFoundException(`User "${userId}" not found`)
    }

    const nextLanguage = payload.language ?? mapLanguagePreference(currentUser.preference?.languagePreference)
    const nextAppearance = payload.appearance ?? mapAppearancePreference(currentUser.preference?.appearancePreference)

    await this.prisma.userPreference.upsert({
      where: { userId },
      update: {
        languagePreference: payload.language === undefined
          ? undefined
          : mapLanguagePreferenceToDb(payload.language),
        appearancePreference: payload.appearance === undefined
          ? undefined
          : mapAppearancePreferenceToDb(payload.appearance),
      },
      create: {
        userId,
        ...(payload.language === undefined
          ? {}
          : { languagePreference: mapLanguagePreferenceToDb(payload.language) }),
        ...(payload.appearance === undefined
          ? {}
          : { appearancePreference: mapAppearancePreferenceToDb(payload.appearance) }),
      },
    })

    return {
      language: nextLanguage,
      appearance: nextAppearance,
    }
  }
}

function buildUserOauthBindings(
  accounts: Array<{ provider: AuthProvider, providerUsername: string | null }>,
): UserSettings['account']['oauthProviders'] {
  const accountsByProvider = new Map(accounts.map(account => [account.provider, account]))

  return Object.fromEntries(AUTH_PROVIDER_VALUES.map((provider) => {
    const account = accountsByProvider.get(resolveDbAuthProvider(provider))

    return [provider, {
      connected: Boolean(account),
      username: account?.providerUsername ?? null,
    }]
  })) as UserSettings['account']['oauthProviders']
}

function resolveDbAuthProvider(provider: (typeof AUTH_PROVIDER_VALUES)[number]): AuthProvider {
  if (provider === AUTH_PROVIDER.GOOGLE) {
    return AuthProvider.GOOGLE
  }

  if (provider === AUTH_PROVIDER.GITHUB) {
    return AuthProvider.GITHUB
  }

  if (provider === AUTH_PROVIDER.LINUX_DO) {
    return AuthProvider.LINUX_DO
  }

  return AuthProvider.GOOGLE
}
