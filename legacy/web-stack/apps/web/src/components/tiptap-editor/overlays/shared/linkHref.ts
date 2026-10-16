const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i
const DOMAIN_HOSTNAME_PATTERN = /^(?:localhost|(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:[a-z]{2,}|xn--[a-z\d-]+)|\d{1,3}(?:\.\d{1,3}){3})$/i
const SINGLE_LABEL_HOSTNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i
const UNSAFE_SCHEMES = new Set(['data:', 'file:', 'javascript:', 'vbscript:'])

export function normalizeLinkHref(input: string): string | null {
  const rawHref = input.trim()

  if (!isNonEmptyLinkHref(rawHref)) {
    return null
  }

  if (isSafeRelativeHref(rawHref)) {
    return rawHref
  }

  if (URL_SCHEME_PATTERN.test(rawHref)) {
    return normalizeSchemeHref(rawHref)
  }

  const candidate = createHttpsHrefCandidate(rawHref)

  if (!candidate) {
    return null
  }

  return normalizeHttpHref(candidate, {
    allowSingleLabelHost: false,
  })
}

export function preserveExistingLinkHref(input: string): string | null {
  const rawHref = input.trim()
  const normalizedHref = normalizeLinkHref(rawHref)

  if (normalizedHref) {
    return normalizedHref
  }

  if (!isNonEmptyLinkHref(rawHref) || isUnsafeSchemeHref(rawHref) || rawHref.startsWith('//')) {
    return null
  }

  return rawHref
}

function normalizeSchemeHref(input: string) {
  try {
    const url = new URL(input)

    if (isUnsafeSchemeHref(url.protocol)) {
      return null
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return isSafeHttpUrl(url, {
        allowSingleLabelHost: true,
      })
        ? formatHttpUrl(url)
        : null
    }

    if (url.protocol === 'mailto:' || url.protocol === 'tel:') {
      return url.href
    }

    return null
  }
  catch {
    return null
  }
}

function createHttpsHrefCandidate(input: string) {
  if (input.startsWith('//')) {
    return null
  }

  const hostCandidate = input.split(/[/?#]/)[0] ?? ''

  if (!isValidHostCandidate(hostCandidate)) {
    return null
  }

  return `https://${input}`
}

function normalizeHttpHref(input: string, options: { allowSingleLabelHost: boolean }) {
  try {
    const url = new URL(input)

    return isSafeHttpUrl(url, options)
      ? formatHttpUrl(url)
      : null
  }
  catch {
    return null
  }
}

function isSafeHttpUrl(url: URL, options: { allowSingleLabelHost: boolean }) {
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && url.username === ''
    && url.password === ''
    && isValidHttpHostname(url.hostname, options)
}

function isValidHostCandidate(hostCandidate: string) {
  if (!hostCandidate || hostCandidate.includes('@')) {
    return false
  }

  const host = hostCandidate.startsWith('[')
    ? ''
    : hostCandidate.split(':')[0] ?? ''

  return DOMAIN_HOSTNAME_PATTERN.test(host)
}

function formatHttpUrl(url: URL) {
  const origin = `${url.protocol}//${url.host}`

  if (url.pathname === '/' && !url.search && !url.hash) {
    return origin
  }

  return `${origin}${url.pathname}${url.search}${url.hash}`
}

function isValidHttpHostname(hostname: string, options: { allowSingleLabelHost: boolean }) {
  return DOMAIN_HOSTNAME_PATTERN.test(hostname)
    || (options.allowSingleLabelHost && SINGLE_LABEL_HOSTNAME_PATTERN.test(hostname))
}

function isSafeRelativeHref(input: string) {
  if (URL_SCHEME_PATTERN.test(input) || input.startsWith('//')) {
    return false
  }

  return input.startsWith('/')
    || input.startsWith('./')
    || input.startsWith('../')
    || input.startsWith('#')
}

function isUnsafeSchemeHref(input: string) {
  const scheme = URL_SCHEME_PATTERN.exec(input)?.[0].toLowerCase()

  return Boolean(scheme && UNSAFE_SCHEMES.has(scheme))
}

function isNonEmptyLinkHref(input: string) {
  return Boolean(input) && !/\s/.test(input)
}
