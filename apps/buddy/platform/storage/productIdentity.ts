import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { productIdSchema } from '../../shared/productProtocol/scalars'
import { storageIdentitySchema } from '../../shared/storage/storageApi'
import { readStorageJson, syncStorageDirectory } from './storageFiles'

const identitySchema = z.object({ version: z.literal(1), serviceId: productIdSchema, profileId: productIdSchema }).strict()
export type StoredProductIdentity = z.infer<typeof identitySchema>

export async function readOrCreateProductIdentity(profileRoot: string): Promise<StoredProductIdentity> {
  const path = join(profileRoot, 'device/service/identity.json')
  const existing = await readStorageJson(path)
  if (existing !== null)
    return identitySchema.parse(existing)
  const storage = await readStorageJson(join(profileRoot, 'storage.json'))
  const identity = identitySchema.parse({ version: 1, serviceId: randomUUID(), profileId: storage === null ? randomUUID() : storageIdentitySchema.parse(storage).dataId })
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(identity))
    await file.sync()
  }
  finally { await file.close() }
  await syncStorageDirectory(dirname(path))
  return identity
}
