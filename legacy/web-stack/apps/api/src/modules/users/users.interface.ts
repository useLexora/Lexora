import type { Buffer } from 'node:buffer'

/**
 * 更新当前用户头像参数。
 */
export interface UpdateCurrentUserAvatarInput {
  fileName: string
  mimeType: string
  buffer: Buffer
}
