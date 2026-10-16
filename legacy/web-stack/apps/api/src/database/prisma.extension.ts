import { Prisma } from '@prisma/client'

const SOFT_DELETE_MODEL_NAMES = new Set([
  'OauthAccount',
  'AuthOauthState',
  'AuthRefreshToken',
  'AuthLoginCode',
  'LocalCredential',
  'AuthEmailVerificationToken',
  'RegistrationInviteGrant',
  'UserEmailVerificationCode',
  'Role',
  'Permission',
  'RolePermission',
  'UserRole',
  'DocumentCurrentProjection',
  'DocumentVersionSnapshot',
  'DocumentAsset',
  'ChatSession',
  'ChatSessionMessage',
  'SystemAuthConfig',
  'SystemEmailConfig',
  'AiProvider',
  'AiProviderModel',
  'AiDefaultModelPolicy',
  'AiPlatformEmbeddingModelPolicy',
  'AgentProfile',
  'AgentMemory',
  'AgentMemoryCandidate',
  'AdminAuditLog',
  'User',
  'UserPreference',
  'Workspace',
  'WorkspaceMember',
  'WorkspaceInvite',
  'PlatformNotification',
  'PlatformNotificationAsset',
])

function supportsSoftDelete(modelName: string | undefined): boolean {
  return !!modelName && SOFT_DELETE_MODEL_NAMES.has(modelName)
}

function injectDeletedAtFilter(modelName: string | undefined, args: Record<string, any>): void {
  if (!supportsSoftDelete(modelName)) {
    return
  }

  args.where ??= {}
  if (!('deletedAt' in args.where)) {
    args.where.deletedAt = null
  }
}

function createSoftDeleteWhere(
  modelName: string | undefined,
  where: Record<string, any> | undefined,
): Record<string, any> {
  const nextWhere = { ...(where ?? {}) }
  if (supportsSoftDelete(modelName) && !('deletedAt' in nextWhere)) {
    nextWhere.deletedAt = null
  }
  return nextWhere
}

export const softDeleteExtension = Prisma.defineExtension({
  query: {
    $allModels: {
      async findFirst({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async findFirstOrThrow({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async findMany({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async findUnique({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async findUniqueOrThrow({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async count({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async aggregate({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async groupBy({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async update({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async updateMany({ model, args, query }) {
        injectDeletedAtFilter(model, args)
        return query(args)
      },

      async upsert({ model, args, query }) {
        args.where ??= {} as any
        if (supportsSoftDelete(model) && !('deletedAt' in (args.where as any))) {
          (args.where as any).deletedAt = null
        }
        return query(args)
      },
    },
  },
  model: {
    $allModels: {
      async delete<T>(
        this: T,
        args: Prisma.Args<T, 'delete'>,
      ): Promise<Prisma.Result<T, Prisma.Args<T, 'delete'>, 'delete'>> {
        const context = Prisma.getExtensionContext(this) as unknown as {
          $name?: string
          update: (args: Prisma.Args<T, 'update'>) => Promise<Prisma.Result<T, Prisma.Args<T, 'update'>, 'update'>>
        }
        const modelName = context.$name

        if (!supportsSoftDelete(modelName)) {
          throw new Error(`${modelName ?? 'Unknown model'} does not support soft delete`)
        }

        return context.update({
          ...(args as Record<string, unknown>),
          where: createSoftDeleteWhere(modelName, (args as { where?: Record<string, any> }).where),
          data: { deletedAt: new Date() },
        } as Prisma.Args<T, 'update'>) as Promise<Prisma.Result<T, Prisma.Args<T, 'delete'>, 'delete'>>
      },

      async deleteMany<T>(
        this: T,
        args?: Prisma.Args<T, 'deleteMany'>,
      ): Promise<Prisma.Result<T, Prisma.Args<T, 'deleteMany'>, 'deleteMany'>> {
        const context = Prisma.getExtensionContext(this) as unknown as {
          $name?: string
          updateMany: (args: Prisma.Args<T, 'updateMany'>) => Promise<Prisma.Result<T, Prisma.Args<T, 'updateMany'>, 'updateMany'>>
        }
        const modelName = context.$name

        if (!supportsSoftDelete(modelName)) {
          throw new Error(`${modelName ?? 'Unknown model'} does not support soft delete`)
        }

        return context.updateMany({
          ...((args ?? {}) as Record<string, unknown>),
          where: createSoftDeleteWhere(modelName, (args as { where?: Record<string, any> } | undefined)?.where),
          data: { deletedAt: new Date() },
        } as Prisma.Args<T, 'updateMany'>) as Promise<Prisma.Result<T, Prisma.Args<T, 'deleteMany'>, 'deleteMany'>>
      },
    },
  },
})
