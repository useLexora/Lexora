import { Buffer } from 'node:buffer'
import { randomBytes, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(rawScrypt)
const SCRYPT_KEY_LENGTH = 64
const PASSWORD_HASH_PREFIX = 'scrypt'

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derivedKey = await scrypt(password, salt, SCRYPT_KEY_LENGTH) as Buffer

  return [
    PASSWORD_HASH_PREFIX,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const [algorithm, encodedSalt, encodedHash] = passwordHash.split('$')

  if (
    algorithm !== PASSWORD_HASH_PREFIX
    || !encodedSalt
    || !encodedHash
  ) {
    return false
  }

  const salt = Buffer.from(encodedSalt, 'base64url')
  const expectedHash = Buffer.from(encodedHash, 'base64url')
  const derivedKey = await scrypt(password, salt, expectedHash.length) as Buffer

  return timingSafeEqual(derivedKey, expectedHash)
}
