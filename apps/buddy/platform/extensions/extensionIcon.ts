import { Buffer } from 'node:buffer'
import { EXTENSION_ICON_LIMIT } from '../../shared/extensions/extensionManifest.ts'

const types: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export function extensionIconUrl(path: string | undefined, bytes: Uint8Array | undefined): string | undefined {
  if (!path)
    return undefined
  const type = types[path.split('.').at(-1)?.toLowerCase() ?? '']
  if (!type || !bytes?.length || bytes.length > EXTENSION_ICON_LIMIT)
    throw new Error('EXTENSION_ICON_INVALID')
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
}
