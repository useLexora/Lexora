import { z } from 'zod'

export const WELCOME_COMPANION_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const WELCOME_COMPANION_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const WELCOME_COMPANION_IMAGE_MAX_DATA_URL_LENGTH = Math.ceil(WELCOME_COMPANION_IMAGE_MAX_BYTES / 3) * 4 + 32

export function isWelcomeCompanionImageDataUrl(value: string): boolean {
  if (value.length > WELCOME_COMPANION_IMAGE_MAX_DATA_URL_LENGTH)
    return false
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match)
    return false
  const [, mime, base64] = match
  let bytes: string
  try {
    bytes = atob(base64!)
    if (bytes.length > WELCOME_COMPANION_IMAGE_MAX_BYTES || btoa(bytes) !== base64)
      return false
  }
  catch {
    return false
  }
  const byte = (offset: number) => bytes.charCodeAt(offset)
  const uint32LE = (offset: number) => byte(offset) + byte(offset + 1) * 256 + byte(offset + 2) * 65536 + byte(offset + 3) * 16777216
  switch (mime) {
    case 'image/png':
      return bytes.length >= 45
        && bytes.startsWith('\x89PNG\r\n\x1A\n\x00\x00\x00\rIHDR')
        && bytes.endsWith('\x00\x00\x00\x00IEND\xAE\x42\x60\x82')
    case 'image/jpeg':
      return bytes.length >= 12 && bytes.startsWith('\xFF\xD8\xFF') && bytes.endsWith('\xFF\xD9')
    case 'image/webp':
      return bytes.length >= 20 && bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP'
        && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.slice(12, 16)) && uint32LE(4) === bytes.length - 8
    case 'image/gif':
      return bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.slice(0, 6))
        && (byte(6) + byte(7) * 256) > 0 && (byte(8) + byte(9) * 256) > 0 && bytes.endsWith(';')
    default:
      return false
  }
}

export const welcomeCompanionImagesSchema = z.array(z.string().refine(
  isWelcomeCompanionImageDataUrl,
  'Expected a PNG, JPEG, WebP or GIF data URL up to 5 MiB',
))

export const welcomeCompanionImageSchema = z.string().refine(
  value => value === 'lexora' || value === 'whale' || isWelcomeCompanionImageDataUrl(value),
  'Expected lexora, whale, or a PNG, JPEG, WebP or GIF data URL up to 5 MiB',
)
