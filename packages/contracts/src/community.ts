import { z } from 'zod'

export const providerSchema = z.enum(['github', 'google', 'linux-do'])
export type Provider = z.infer<typeof providerSchema>
export const handleSchema = z.string().min(3).max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
export const publisherInputSchema = z.object({
  handle: handleSchema,
  displayName: z.string().trim().min(1).max(80),
}).strict()
export const httpsUrlSchema = z.url().max(2048).refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash
})
export const repositorySchema = httpsUrlSchema.refine(value => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(value))
export const pluginMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
  version: z.string().max(64).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i),
  apiVersion: z.number().int().positive(),
  engines: z.object({ lexora: z.string().min(1).max(100) }).strict(),
  categories: z.array(z.string().min(1).max(40)).max(8).default([]),
  tags: z.array(z.string().min(1).max(40)).max(16).default([]),
})
export const manifestSchema = pluginMetadataSchema.loose()
export const artifactSchema = z.object({
  url: httpsUrlSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(16 * 1024 * 1024),
}).strict()
export const releaseInputSchema = z.object({
  manifest: manifestSchema,
  repository: repositorySchema,
  artifact: artifactSchema,
  notes: z.string().max(4000).default(''),
}).strict()
export const reviewInputSchema = z.object({
  action: z.enum(['publish', 'reject', 'yank']),
  reason: z.string().trim().min(1).max(1000),
}).strict()
export const listQuerySchema = z.object({
  q: z.string().trim().max(100).default(''),
  category: z.string().trim().max(40).default(''),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(24),
})
export type ReleaseInput = z.infer<typeof releaseInputSchema>
export type Manifest = z.infer<typeof manifestSchema>
export interface Publisher { id: string, handle: string, displayName: string }
export interface Account { provider: Provider, subject: string }
export interface CurrentUser { id: string, name: string, publisher: Publisher | null, accounts: Account[], admin: boolean }
export interface SessionResponse { user: CurrentUser | null, providers: Provider[] }
export interface PluginRelease extends ReleaseInput {
  id: string
  status: 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'YANKED'
  reviewReason: string | null
  createdAt: string
  publishedAt: string | null
}
export interface Plugin {
  id: string
  publisher: Publisher
  release: { id: string, manifest: z.infer<typeof pluginMetadataSchema>, publishedAt: string | null }
}
export interface PluginDetail extends Plugin { release: PluginRelease, releases: PluginRelease[] }
export interface PluginPage { items: Plugin[], total: number, page: number, pageSize: number }
export interface Catalog {
  schemaVersion: 1
  plugins: { manifest: Manifest, repository: string, artifact: ReleaseInput['artifact'] }[]
}
