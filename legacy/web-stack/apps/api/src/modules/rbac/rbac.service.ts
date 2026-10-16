import type { PermissionCode, RoleCode } from '@haohaoxue/lexora-contracts'
import type { Prisma } from '@prisma/client'
import { PermissionSchema, ROLES, RoleSchema } from '@haohaoxue/lexora-contracts'
import { Injectable, OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../../database/prisma.service'
import { DEFAULT_RBAC_SEED } from './rbac.constants'

@Injectable()
export class RbacService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaults()
  }

  async seedDefaults() {
    await this.prisma.$bypass.$transaction(async (tx) => {
      const permissionByCode = new Map<string, { id: string }>()

      for (const permission of DEFAULT_RBAC_SEED.permissions) {
        const stored = await tx.permission.upsert({
          where: { code: permission.code },
          update: { description: permission.description },
          create: {
            code: permission.code,
            description: permission.description,
          },
          select: { id: true },
        })
        permissionByCode.set(permission.code, stored)
      }

      for (const role of DEFAULT_RBAC_SEED.roles) {
        const storedRole = await tx.role.upsert({
          where: { code: role.code },
          update: { name: role.name },
          create: {
            code: role.code,
            name: role.name,
          },
          select: { id: true },
        })

        await tx.rolePermission.deleteMany({
          where: { roleId: storedRole.id },
        })

        if (!role.permissions.length) {
          continue
        }

        await tx.rolePermission.createMany({
          data: role.permissions.map<Prisma.RolePermissionCreateManyInput>(permissionCode => ({
            roleId: storedRole.id,
            permissionId: permissionByCode.get(permissionCode)!.id,
          })),
          skipDuplicates: true,
        })
      }
    })
  }

  async getUserRoleAndPermissions(userId: string): Promise<{ roles: RoleCode[], permissions: PermissionCode[] }> {
    const roleRows = await this.prisma.userRole.findMany({
      where: { userId },
      select: {
        role: {
          select: {
            code: true,
            rolePermissions: {
              select: {
                permission: {
                  select: {
                    code: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    const roles = roleRows.map(row => RoleSchema.parse(row.role.code))
    const permissionSet = new Set<PermissionCode>()

    for (const row of roleRows) {
      for (const rolePermission of row.role.rolePermissions) {
        permissionSet.add(PermissionSchema.parse(rolePermission.permission.code))
      }
    }

    return {
      roles,
      permissions: [...permissionSet],
    }
  }

  async ensureDefaultUserRole(userId: string) {
    const roleId = await this.getRoleIdByCode(ROLES.USER)
    await this.attachUserRole(userId, roleId)
  }

  async ensureSystemAdminRole(userId: string): Promise<void> {
    const roleId = await this.getRoleIdByCode(ROLES.SYSTEM_ADMIN)
    await this.attachUserRole(userId, roleId)
  }

  async revokeSystemAdminRole(userId: string): Promise<void> {
    const roleId = await this.getRoleIdByCode(ROLES.SYSTEM_ADMIN)
    await this.prisma.$bypass.userRole.deleteMany({
      where: {
        userId,
        roleId,
      },
    })
  }

  async enforceSystemAdminRole(systemAdminUserId: string | null): Promise<void> {
    const roleId = await this.getRoleIdByCode(ROLES.SYSTEM_ADMIN)

    if (systemAdminUserId) {
      await this.attachUserRole(systemAdminUserId, roleId)
    }

    await this.prisma.$bypass.userRole.deleteMany({
      where: systemAdminUserId
        ? {
            roleId,
            NOT: {
              userId: systemAdminUserId,
            },
          }
        : {
            roleId,
          },
    })
  }

  async syncBootstrapRolesForUser(userId: string): Promise<void> {
    const [user, authConfig, systemAdminRoleId] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
        },
      }),
      this.prisma.systemAuthConfig.findFirst({
        select: {
          systemAdminUserId: true,
        },
      }),
      this.getRoleIdByCode(ROLES.SYSTEM_ADMIN),
    ])

    if (!user) {
      return
    }

    await this.ensureDefaultUserRole(userId)

    if (authConfig?.systemAdminUserId === userId) {
      await this.attachUserRole(userId, systemAdminRoleId)
      return
    }

    await this.prisma.$bypass.userRole.deleteMany({
      where: {
        userId,
        roleId: systemAdminRoleId,
      },
    })
  }

  async isSystemAdmin(userId: string): Promise<boolean> {
    const authConfig = await this.prisma.systemAuthConfig.findFirst({
      select: {
        systemAdminUserId: true,
      },
    })

    return authConfig?.systemAdminUserId === userId
  }

  async getRoleIdByCode(code: string): Promise<string> {
    const role = await this.prisma.role.findUnique({
      where: { code },
      select: { id: true },
    })

    if (role) {
      return role.id
    }

    await this.seedDefaults()
    return this.prisma.role.findUniqueOrThrow({
      where: { code },
      select: { id: true },
    }).then(result => result.id)
  }

  private async attachUserRole(userId: string, roleId: string) {
    const existing = await this.prisma.$bypass.userRole.findUnique({
      where: {
        userId_roleId: {
          userId,
          roleId,
        },
      },
      select: {
        userId: true,
      },
    })

    if (existing) {
      return
    }

    await this.prisma.$bypass.userRole.create({
      data: {
        userId,
        roleId,
      },
    })
  }
}
