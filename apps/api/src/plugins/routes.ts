import type { PrismaClient } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import type { Auth } from '../auth/service.ts'
import { listQuerySchema, pluginMetadataSchema, publisherInputSchema, releaseInputSchema, reviewInputSchema } from '@uselexora/lexora-contracts/community'
import { z } from 'zod'
import { ApiError } from '../errors.ts'
import { reviewRelease, serializeRelease, sortReleases, submitRelease } from './service.ts'

export function registerPluginRoutes(app: FastifyInstance, db: PrismaClient, auth: Auth) {
  const publicPublisher = (publisher: { id: string, handle: string, displayName: string }) => ({ id: publisher.id, handle: publisher.handle, displayName: publisher.displayName })
  app.get('/api/plugins', async (request, reply) => {
    const { q, category, page, pageSize } = listQuerySchema.parse(request.query)
    const where = { releases: { some: { status: 'PUBLISHED' as const, ...(category ? { manifest: { path: ['categories'], array_contains: [category] } } : {}), ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { description: { contains: q, mode: 'insensitive' as const } }, { pluginId: { contains: q, mode: 'insensitive' as const } }] } : {}) } } }
    const [total, plugins] = await db.$transaction([
      db.plugin.count({ where }),
      db.plugin.findMany({ where, include: { publisher: true, releases: { where: { status: 'PUBLISHED' } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ])
    reply.header('Cache-Control', 'public, max-age=30')
    return { items: plugins.map((plugin) => {
      const latest = sortReleases(plugin.releases)[0]!
      return { id: plugin.id, publisher: publicPublisher(plugin.publisher), release: { id: latest.id, manifest: pluginMetadataSchema.parse(latest.manifest), publishedAt: latest.publishedAt?.toISOString() ?? null } }
    }), total, page, pageSize }
  })
  app.get('/api/categories', async (_request, reply) => {
    const categories = await db.$queryRaw<{ category: string }[]>`
      SELECT DISTINCT jsonb_array_elements_text(manifest->'categories') AS category
      FROM "PluginRelease" WHERE status = 'PUBLISHED' ORDER BY category
    `
    reply.header('Cache-Control', 'public, max-age=60')
    return categories.map(item => item.category)
  })
  app.get<{ Params: { id: string } }>('/api/plugins/:id', async (request, reply) => {
    const plugin = await db.plugin.findUnique({ where: { id: request.params.id }, include: { publisher: true, releases: { where: { status: 'PUBLISHED' } } } })
    if (!plugin || !plugin.releases.length)
      throw new ApiError(404, 'PLUGIN_NOT_FOUND')
    const releases = sortReleases(plugin.releases).map(serializeRelease)
    reply.header('Cache-Control', 'public, max-age=30')
    return { id: plugin.id, publisher: publicPublisher(plugin.publisher), release: releases[0], releases }
  })
  app.get('/api/catalog/v1/index.json', async (_request, reply) => {
    const releases = await db.pluginRelease.findMany({ where: { status: 'PUBLISHED' }, orderBy: [{ pluginId: 'asc' }, { createdAt: 'desc' }], take: 2001 })
    if (releases.length > 2000)
      throw new ApiError(503, 'CATALOG_CAPACITY_EXCEEDED')
    reply.header('Cache-Control', 'public, max-age=60')
    return { schemaVersion: 1, plugins: releases.map((release) => {
      const serialized = serializeRelease(release)
      return { manifest: serialized.manifest, repository: serialized.repository, artifact: serialized.artifact }
    }) }
  })
  app.post('/api/publisher', async (request) => {
    const user = await auth.requireUser(request)
    const input = publisherInputSchema.parse(request.body)
    if (['lexora', 'uselexora', 'admin', 'support', 'official', 'system'].includes(input.handle) && !user.admin)
      throw new ApiError(409, 'HANDLE_RESERVED')
    if (user.publisher) {
      if (user.publisher.handle !== input.handle)
        throw new ApiError(409, 'HANDLE_IMMUTABLE')
      return publicPublisher(await db.publisher.update({ where: { id: user.publisher.id }, data: { displayName: input.displayName } }))
    }
    return publicPublisher(await db.publisher.create({ data: { ...input, userId: user.id } }))
  })
  app.get('/api/publisher/releases', async (request) => {
    const user = await auth.requireUser(request)
    if (!user.publisher)
      return []
    const releases = await db.pluginRelease.findMany({ where: { plugin: { publisherId: user.publisher.id } }, orderBy: { createdAt: 'desc' }, take: 200 })
    return releases.map(serializeRelease)
  })
  app.post('/api/releases', async (request, reply) => {
    const user = await auth.requireUser(request)
    if (!user.publisher)
      throw new ApiError(409, 'PUBLISHER_REQUIRED')
    const release = await submitRelease(db, user.publisher.id, releaseInputSchema.parse(request.body))
    reply.code(201)
    return serializeRelease(release)
  })
  app.get('/api/reviews', async (request) => {
    const user = await auth.requireUser(request)
    if (!user.admin)
      throw new ApiError(403, 'ADMIN_REQUIRED')
    const releases = await db.pluginRelease.findMany({ where: { status: 'PENDING' }, include: { plugin: { include: { publisher: true } } }, orderBy: { createdAt: 'asc' }, take: 100 })
    return releases.map(release => ({ ...serializeRelease(release), publisher: publicPublisher(release.plugin.publisher) }))
  })
  app.post<{ Params: { id: string } }>('/api/reviews/:id', async (request) => {
    const user = await auth.requireUser(request)
    if (!user.admin)
      throw new ApiError(403, 'ADMIN_REQUIRED')
    const { action, reason } = reviewInputSchema.parse(request.body)
    return reviewRelease(db, z.uuid().parse(request.params.id), user.id, action, reason)
  })
}
