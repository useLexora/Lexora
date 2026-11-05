import { z } from 'zod'

export const EXTENSION_NETWORK_LINK_BYTES_LIMIT = 16 * 1024

const extensionNetworkLinkSchema = z.string().min(1).max(EXTENSION_NETWORK_LINK_BYTES_LIMIT).refine(value => new TextEncoder().encode(value).byteLength <= EXTENSION_NETWORK_LINK_BYTES_LIMIT)
export const extensionNetworkResponseSchema = z.object({
  status: z.number().int().min(0).max(599),
  text: z.string().max(1024 * 1024),
  headers: z.object({ link: extensionNetworkLinkSchema.optional() }).strict(),
}).strict()
export type ExtensionNetworkResponse = z.infer<typeof extensionNetworkResponseSchema>

export function projectExtensionNetworkHeaders(headers: Pick<Headers, 'get'>): ExtensionNetworkResponse['headers'] {
  const value = headers.get('link')
  if (!value)
    return {}
  const link = extensionNetworkLinkSchema.safeParse(value)
  if (!link.success)
    throw new Error('EXTENSION_NETWORK_HEADERS_TOO_LARGE')
  return { link: link.data }
}
