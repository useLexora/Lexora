import type { PluginRelease, PrismaClient } from '@prisma/client'
import type { ReleaseInput } from '@uselexora/lexora-contracts/community'
import { Prisma } from '@prisma/client'
import { manifestSchema } from '@uselexora/lexora-contracts/community'
import { rcompare, valid, validRange } from 'semver'
import { ApiError } from '../errors.ts'

export function serializeRelease(release: PluginRelease) {
  return {
    id: release.id,
    manifest: manifestSchema.parse(release.manifest),
    repository: release.repository,
    artifact: { url: release.artifactUrl, sha256: release.sha256, size: release.size },
    notes: release.notes,
    status: release.status,
    reviewReason: release.reviewReason,
    createdAt: release.createdAt.toISOString(),
    publishedAt: release.publishedAt?.toISOString() ?? null,
  }
}
export function sortReleases<T extends { version: string }>(releases: T[]) {
  return releases.sort((a, b) => rcompare(a.version, b.version))
}

export async function submitRelease(db: PrismaClient, publisherId: string, input: ReleaseInput) {
  if (!valid(input.manifest.version) || !validRange(input.manifest.engines.lexora))
    throw new ApiError(400, 'INVALID_MANIFEST')
  return db.$transaction(async (tx) => {
    const publisher = await tx.publisher.findUniqueOrThrow({ where: { id: publisherId } })
    if ((input.manifest.id.startsWith('lexora.') || input.manifest.id.startsWith('uselexora.')) && publisher.handle !== 'lexora')
      throw new ApiError(403, 'PLUGIN_ID_RESERVED')
    const plugin = await tx.plugin.findUnique({ where: { id: input.manifest.id } })
    if (plugin && plugin.publisherId !== publisherId)
      throw new ApiError(403, 'PLUGIN_OWNED_BY_ANOTHER_PUBLISHER')
    if (!plugin && !input.manifest.id.startsWith(`${publisher.handle}.`))
      throw new ApiError(400, 'PLUGIN_NAMESPACE_REQUIRED')
    if (!plugin)
      await tx.plugin.create({ data: { id: input.manifest.id, publisherId } })
    return tx.pluginRelease.create({ data: {
      pluginId: input.manifest.id,
      version: input.manifest.version,
      name: input.manifest.name,
      description: input.manifest.description,
      manifest: input.manifest as Prisma.InputJsonObject,
      repository: input.repository,
      artifactUrl: input.artifact.url,
      sha256: input.artifact.sha256,
      size: input.artifact.size,
      notes: input.notes,
    } })
  })
}

export async function reviewRelease(db: PrismaClient, id: string, reviewer: string, action: 'publish' | 'reject' | 'yank', reason: string) {
  const expected = action === 'yank' ? 'PUBLISHED' : 'PENDING'
  const status = action === 'publish' ? 'PUBLISHED' : action === 'reject' ? 'REJECTED' : 'YANKED'
  const result = await db.pluginRelease.updateMany({ where: { id, status: expected }, data: { status, reviewReason: reason, reviewedBy: reviewer, ...(action === 'publish' ? { publishedAt: new Date() } : {}) } })
  if (result.count !== 1)
    throw new ApiError(409, 'RELEASE_STATE_CONFLICT')
  return { ok: true }
}
