import { Buffer } from 'node:buffer'
import { hkdfSync } from 'node:crypto'
import { getEnv } from './env.schema'

const MIN_APP_SECRET_LENGTH = 32
const HKDF_SALT = Buffer.from('lexora-api', 'utf8')

interface DerivedSecretMaterial {
  encryptionKey: string
  jwtAccessSecret: string
}

let cachedSecretMaterial: DerivedSecretMaterial | undefined

export function getDerivedSecretMaterial(): DerivedSecretMaterial {
  cachedSecretMaterial ??= deriveSecretMaterial()
  return cachedSecretMaterial
}

function deriveSecretMaterial(): DerivedSecretMaterial {
  const masterSecret = resolveMasterSecret()

  return {
    encryptionKey: deriveSecret(masterSecret, 'lexora:encryption', 32).toString('hex'),
    jwtAccessSecret: deriveSecret(masterSecret, 'lexora:jwt-access', 32).toString('base64url'),
  }
}

function resolveMasterSecret(): Buffer {
  const env = getEnv()

  if (env.APP_SECRET.length < MIN_APP_SECRET_LENGTH) {
    throw new Error(`Invalid APP_SECRET. It must be at least ${MIN_APP_SECRET_LENGTH} characters long.`)
  }

  return Buffer.from(env.APP_SECRET, 'utf8')
}

function deriveSecret(masterSecret: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    masterSecret,
    HKDF_SALT,
    Buffer.from(info, 'utf8'),
    length,
  ))
}
