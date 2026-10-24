import {
  isWelcomeCompanionImageDataUrl,
  WELCOME_COMPANION_IMAGE_MAX_BYTES,
  WELCOME_COMPANION_IMAGE_MIME_TYPES,
} from '@buddy-electron/shared/welcomeCompanionImage'

export class WelcomeCompanionImageError extends Error {
  constructor(readonly reason: 'type' | 'size' | 'read') {
    super(reason)
  }
}

export async function readWelcomeCompanionImage(file: File): Promise<string> {
  if (!(WELCOME_COMPANION_IMAGE_MIME_TYPES as readonly string[]).includes(file.type))
    throw new WelcomeCompanionImageError('type')
  if (file.size > WELCOME_COMPANION_IMAGE_MAX_BYTES)
    throw new WelcomeCompanionImageError('size')

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new WelcomeCompanionImageError('read'))
    reader.onerror = reader.onabort = () => reject(new WelcomeCompanionImageError('read'))
    try {
      reader.readAsDataURL(file)
    }
    catch {
      reject(new WelcomeCompanionImageError('read'))
    }
  })
  if (!isWelcomeCompanionImageDataUrl(dataUrl))
    throw new WelcomeCompanionImageError('type')

  const image = new Image()
  image.src = dataUrl
  try {
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error('Empty image')
  }
  catch {
    throw new WelcomeCompanionImageError('type')
  }
  finally {
    image.removeAttribute('src')
  }
  return dataUrl
}
