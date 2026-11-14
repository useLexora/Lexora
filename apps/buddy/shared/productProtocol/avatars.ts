import { z } from 'zod'
import { BUDDY_AVATAR_MAX_BYTES, BUDDY_AVATAR_PRESET_IDS } from '../buddies/buddyApi'
import { productIdSchema } from './scalars'

export const productAvatarSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default') }).strict(),
  z.object({ kind: z.literal('preset'), preset: z.enum(BUDDY_AVATAR_PRESET_IDS) }).strict(),
  z.object({ kind: z.literal('image'), sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), sizeBytes: z.number().int().min(1).max(BUDDY_AVATAR_MAX_BYTES) }).strict(),
])
export const productBuddyAvatarSchema = z.object({ buddyId: productIdSchema, avatar: productAvatarSchema }).strict()
