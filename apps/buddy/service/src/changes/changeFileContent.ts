import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import { basename, extname, sep } from 'node:path'
import { relativeCanonicalPath } from '../../../platform/filesystem/filePaths'

export const MAX_CHANGE_TEXT_BYTES = 1024 * 1024
export const MAX_CHANGE_HASH_BYTES = 32 * 1024 * 1024
export function displayGrantedPath(
  cwd: string,
  grant: DirectoryGrant,
  path: string,
): string {
  const result = relativeCanonicalPath(grant.canonicalRoot, path)
  if (!result)
    throw new Error('PATH_OUTSIDE_GRANTED_DIRECTORY')
  const normalized = result.split(sep).join('/')
  return grant.canonicalRoot === cwd ? normalized : `${basename(grant.root)}/${normalized}`
}

export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0))
    return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return null
  }
}

export function isSensitivePath(path: string): boolean {
  return path.split('/').some((segment) => {
    const name = segment.toLowerCase()
    const extension = extname(name)
    const isEnv = name === '.env' || name.startsWith('.env.')
    const isTemplate = /\.(?:example|sample|template|defaults?|dist|schema)$/i.test(name)
    return (isEnv && !isTemplate)
      || ['.credential', '.key', '.p12', '.pem'].includes(extension)
      || ['id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa'].includes(name)
  })
}
