import type { UpdateCurrentUserAvatarResponse } from '@haohaoxue/lexora-contracts'
import type { StorageObject } from '../../infrastructure/storage/storage.interface'
import type { AuthUserContext } from '../auth/auth.interface'
import type { UpdateCurrentUserAvatarInput } from './users.interface'
import { ROLES } from '@haohaoxue/lexora-contracts'
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../../database/prisma.service'
import { StorageService } from '../../infrastructure/storage/storage.service'
import { AVATAR_BUCKET } from './users.constants'
import {
  assertAvatarBuffer,
  assertAvatarMimeType,
  buildAvatarStorageKey,
  buildAvatarUrl,
} from './users.utils'

@Injectable()
export class UserAvatarsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  async updateCurrentUserAvatar(
    authUser: AuthUserContext,
    payload: UpdateCurrentUserAvatarInput,
  ): Promise<UpdateCurrentUserAvatarResponse> {
    if (authUser.roles.includes(ROLES.SYSTEM_ADMIN)) {
      throw new BadRequestException('系统管理员账号不支持修改头像')
    }

    const currentUser = await this.prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        avatarStorageKey: true,
      },
    })

    if (!currentUser) {
      throw new NotFoundException(`User "${authUser.id}" not found`)
    }

    const avatarMimeType = assertAvatarMimeType(payload.mimeType)
    assertAvatarBuffer(payload.buffer, avatarMimeType)
    const avatarStorageKey = buildAvatarStorageKey(authUser.id, avatarMimeType)

    await this.storageService.putObject({
      bucket: AVATAR_BUCKET,
      key: avatarStorageKey,
      body: payload.buffer,
      contentType: avatarMimeType,
      contentDisposition: {
        type: 'inline',
        fileName: payload.fileName,
        fallbackFileName: 'avatar',
      },
      contentLength: payload.buffer.length,
    })

    const avatarUrl = buildAvatarUrl(authUser.id)

    await this.prisma.user.update({
      where: { id: authUser.id },
      data: {
        avatarUrl,
        avatarStorageKey,
      },
    })

    await this.removeAvatarObject(currentUser.avatarStorageKey)

    return {
      avatarUrl,
    }
  }

  async getUserAvatar(userId: string): Promise<StorageObject> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        avatarStorageKey: true,
      },
    })

    if (!user?.avatarStorageKey) {
      throw new NotFoundException('头像不存在')
    }

    return this.storageService.getObject({
      bucket: AVATAR_BUCKET,
      key: user.avatarStorageKey,
    })
  }

  async removeAvatarObject(key: string | null | undefined): Promise<void> {
    if (!key) {
      return
    }

    await this.storageService.deleteObject({
      bucket: AVATAR_BUCKET,
      key,
    })
  }
}
