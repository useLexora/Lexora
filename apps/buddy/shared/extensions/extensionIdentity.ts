import { z } from 'zod'

const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export const EXTENSION_AUTHOR_MAX_LENGTH = 80
export const extensionAuthorSchema = z.string().max(1024).refine(value =>
  value === value.trim()
  && !/[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u.test(value)
  && [...characters.segment(value)].length <= EXTENSION_AUTHOR_MAX_LENGTH, 'Expected a single-line author name of at most 80 characters')
export const extensionSlugSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/)

export function createExtensionId(slug: string): string {
  return `p${crypto.randomUUID().replaceAll('-', '')}.${extensionSlugSchema.parse(slug)}`
}
