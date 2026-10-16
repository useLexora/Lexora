import { translate } from '@/i18n'

const ANIMATED_GIF_SOURCE_PATTERN = /^data:image\/gif[;,]|\.gif(?:[?#]|$)/i
const PASTED_IMAGE_SOURCE_ATTRIBUTES = ['src', 'data-src', 'data-original', 'data-url', 'data-gif-src']

export function hasAnimatedGifPasteSource(html: string): boolean {
  return Boolean(resolveAnimatedGifPasteSource(html))
}

export async function createAnimatedGifPasteFile(html: string): Promise<File | null> {
  const source = resolveAnimatedGifPasteSource(html)

  if (!source || typeof fetch !== 'function') {
    return null
  }

  const response = await fetch(source, {
    credentials: 'omit',
  })

  if (!response.ok) {
    throw new Error(translate('editor.upload.gifDownloadFailed'))
  }

  const blob = await response.blob()

  if (!isGifBlob(blob, source)) {
    throw new Error(translate('editor.upload.gifInvalid'))
  }

  return new File([blob], resolveGifFileName(source), {
    type: 'image/gif',
  })
}

function resolveAnimatedGifPasteSource(html: string): string | null {
  if (!html.trim() || typeof document === 'undefined') {
    return null
  }

  const template = document.createElement('template')
  template.innerHTML = html

  for (const image of Array.from(template.content.querySelectorAll('img'))) {
    const source = resolveAnimatedGifImageSource(image)

    if (source) {
      return source
    }
  }

  return null
}

function resolveAnimatedGifImageSource(image: HTMLImageElement): string | null {
  for (const attribute of PASTED_IMAGE_SOURCE_ATTRIBUTES) {
    const source = normalizeAnimatedGifSource(image.getAttribute(attribute))

    if (source) {
      return source
    }
  }

  const srcsetSource = resolveAnimatedGifSrcsetSource(image.getAttribute('srcset'))

  if (srcsetSource) {
    return srcsetSource
  }

  return null
}

function resolveAnimatedGifSrcsetSource(srcset: string | null): string | null {
  if (!srcset) {
    return null
  }

  for (const candidate of srcset.split(',')) {
    const source = normalizeAnimatedGifSource(candidate.trim().split(/\s+/)[0])

    if (source) {
      return source
    }
  }

  return null
}

function normalizeAnimatedGifSource(value: string | null | undefined): string | null {
  const source = value?.trim()

  if (!source || !ANIMATED_GIF_SOURCE_PATTERN.test(source)) {
    return null
  }

  if (source.toLowerCase().startsWith('data:image/gif')) {
    return source
  }

  try {
    const url = new URL(source, document.baseURI)

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href
    }
  }
  catch {
    return null
  }

  return null
}

function isGifBlob(blob: Blob, source: string): boolean {
  return blob.type === 'image/gif' || (!blob.type && ANIMATED_GIF_SOURCE_PATTERN.test(source))
}

function resolveGifFileName(source: string): string {
  try {
    const url = new URL(source)
    const fileName = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')
      .replace(/[\\/:*?"<>|]/g, '_')

    if (fileName.toLowerCase().endsWith('.gif')) {
      return fileName
    }
  }
  catch {
    return 'pasted-animation.gif'
  }

  return 'pasted-animation.gif'
}
