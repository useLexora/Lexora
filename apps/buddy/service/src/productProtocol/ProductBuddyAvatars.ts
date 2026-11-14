import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import type { productAvatarSchema } from '../../../shared/productProtocol/avatars'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { BUDDY_AVATAR_MAX_BYTES, buddyAvatarSchema } from '../../../shared/buddies/buddyApi'

export class ProductBuddyAvatars {
  readonly #database: DatabaseSync
  constructor(database: DatabaseSync) {
    this.#database = database
  }

  metadata(buddyIds: string[]) {
    return { items: [...new Set(buddyIds)].map(buddyId => ({ buddyId, avatar: this.read(buddyId).avatar })) }
  }

  read(buddyId: string): { avatar: z.infer<typeof productAvatarSchema>, bytes?: Buffer } {
    const row = this.#database.prepare('SELECT avatar FROM buddies WHERE id = ?').get(buddyId)
    const parsed = buddyAvatarSchema.safeParse(row?.avatar ?? null)
    const source = parsed.success ? parsed.data : null
    if (!source)
      return { avatar: { kind: 'default' } }
    if (source.startsWith('preset:'))
      return { avatar: { kind: 'preset', preset: source.slice(7) as Extract<z.infer<typeof productAvatarSchema>, { kind: 'preset' }>['preset'] } }
    const [header, data] = source.split(',')
    const bytes = Buffer.from(data!, 'base64')
    if (!bytes.length || bytes.length > BUDDY_AVATAR_MAX_BYTES || bytes.toString('base64') !== data)
      return { avatar: { kind: 'default' } }
    return { avatar: { kind: 'image', sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: header!.slice(5, -7) as 'image/png' | 'image/jpeg' | 'image/webp', sizeBytes: bytes.length }, bytes }
  }
}
