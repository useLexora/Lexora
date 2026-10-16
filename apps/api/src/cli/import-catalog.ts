import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { Prisma } from '@prisma/client'
import { handleSchema, providerSchema, releaseInputSchema } from '@uselexora/lexora-contracts/community'
import { valid, validRange } from 'semver'
import { z } from 'zod'
import { readConfig } from '../config.ts'
import { createDatabase } from '../database.ts'

const { values } = parseArgs({ options: { file: { type: 'string' }, owner: { type: 'string' }, publisher: { type: 'string' }, name: { type: 'string' } } })
if (!values.file || !values.owner || !values.publisher || !values.name)
  throw new Error('Usage: catalog:import --file catalog.json --owner github:123 --publisher handle --name "Display name"')
const [providerValue, ...subjectParts] = values.owner.split(':')
const provider = providerSchema.parse(providerValue)
const subject = z.string().min(1).parse(subjectParts.join(':'))
const handle = handleSchema.parse(values.publisher)
const displayName = z.string().trim().min(1).max(80).parse(values.name)
const catalog = z.object({ schemaVersion: z.literal(1), plugins: z.array(z.looseObject({ manifest: z.unknown(), repository: z.unknown(), artifact: z.unknown() })).max(2000) }).strict().parse(JSON.parse(await readFile(values.file, 'utf8')))
const inputs = catalog.plugins.map(entry => releaseInputSchema.parse({ manifest: entry.manifest, repository: entry.repository, artifact: entry.artifact }))
if (inputs.some(input => !valid(input.manifest.version) || !validRange(input.manifest.engines.lexora)))
  throw new Error('Invalid manifest version or engine range')
const db = createDatabase(readConfig().DATABASE_URL)
try {
  await db.$transaction(async (tx) => {
    const account = await tx.oAuthAccount.findUnique({ where: { provider_subject: { provider, subject } } })
    if (!account)
      throw new Error('The owner must sign in before importing a catalog')
    const existing = await tx.publisher.findUnique({ where: { handle } })
    if (existing && existing.userId !== account.userId)
      throw new Error('Publisher belongs to another account')
    const publisher = existing ?? await tx.publisher.create({ data: { handle, displayName, userId: account.userId } })
    for (const input of inputs) {
      const { manifest, artifact } = input
      const plugin = await tx.plugin.findUnique({ where: { id: manifest.id } })
      if (plugin && plugin.publisherId !== publisher.id)
        throw new Error(`Plugin ownership conflict: ${manifest.id}`)
      if (!plugin)
        await tx.plugin.create({ data: { id: manifest.id, publisherId: publisher.id } })
      const existingRelease = await tx.pluginRelease.findUnique({ where: { pluginId_version: { pluginId: manifest.id, version: manifest.version } } })
      if (existingRelease) {
        if (existingRelease.status !== 'PUBLISHED' || existingRelease.sha256 !== artifact.sha256 || existingRelease.artifactUrl !== artifact.url || existingRelease.size !== artifact.size || existingRelease.repository !== input.repository || !isDeepStrictEqual(existingRelease.manifest, manifest))
          throw new Error(`Immutable release conflict: ${manifest.id}@${manifest.version}`)
        continue
      }
      await tx.pluginRelease.create({ data: {
        pluginId: manifest.id,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        manifest: manifest as Prisma.InputJsonObject,
        repository: input.repository,
        artifactUrl: artifact.url,
        sha256: artifact.sha256,
        size: artifact.size,
        notes: input.notes,
        status: 'PUBLISHED',
        reviewedBy: account.userId,
        reviewReason: 'Catalog imported by administrator',
        publishedAt: new Date(),
      } })
    }
  }, { timeout: 30000 })
  console.log(`Imported ${inputs.length} catalog entries for ${handle}`)
}
finally {
  await db.$disconnect()
}
