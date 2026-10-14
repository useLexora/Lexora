import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { z } from 'zod'
import { storageError } from './storageFiles'

function derive(password: string, salt: Uint8Array) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))
  })
}
const envelopeSchema = z.object({ version: z.literal(1), salt: z.string().regex(/^[a-f0-9]{32}$/), iv: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/), data: z.string().max(24 * 1024 * 1024) }).strict()
export async function encryptBackupCredentials(value: unknown, password: string): Promise<Uint8Array> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await derive(password, salt)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from('lexora-backup-credentials-v1'))
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return Buffer.from(JSON.stringify({ version: 1, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') }))
  }
  finally { key.fill(0) }
}
export async function decryptBackupCredentials(bytes: Uint8Array, password: string): Promise<unknown> {
  if (bytes.length > 24 * 1024 * 1024)
    throw storageError('SNAPSHOT_INVALID_CREDENTIALS')
  const envelope = envelopeSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
  const key = await derive(password, Buffer.from(envelope.salt, 'hex'))
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'))
    decipher.setAAD(Buffer.from('lexora-backup-credentials-v1'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'))
  }
  catch { throw storageError('SNAPSHOT_PASSWORD_INVALID') }
  finally { key.fill(0) }
}
