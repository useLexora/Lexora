const HTTP_PUBLICATION_HREF_PATTERN = /^https?:\/\//i

export function normalizePublicationHref(value: string | null | undefined): string | null {
  const href = value?.trim() ?? ''

  if (!href) {
    return null
  }

  if (HTTP_PUBLICATION_HREF_PATTERN.test(href)) {
    try {
      const url = new URL(href)
      return url.protocol === 'http:' || url.protocol === 'https:' ? href : null
    }
    catch {
      return null
    }
  }

  if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')) {
    return href
  }

  return null
}

export function isSafePublicationHref(value: string | null | undefined): boolean {
  return normalizePublicationHref(value) !== null
}

export function isExternalPublicationHref(value: string | null | undefined): boolean {
  const href = normalizePublicationHref(value)

  return Boolean(href && HTTP_PUBLICATION_HREF_PATTERN.test(href))
}
