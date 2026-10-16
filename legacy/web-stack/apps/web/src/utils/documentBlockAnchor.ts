const FALLBACK_ORIGIN = 'https://lexora.local'

export function buildDocumentBlockHash(blockId: string) {
  return `#${encodeURIComponent(blockId)}`
}

export function buildDocumentBlockUrl(blockId: string, currentHref: string) {
  const url = new URL(currentHref, FALLBACK_ORIGIN)

  url.hash = buildDocumentBlockHash(blockId)
  return url.toString()
}

export function replaceCurrentDocumentBlockHash(blockId: string) {
  const nextHref = buildDocumentBlockUrl(blockId, window.location.href)

  window.history.replaceState(window.history.state, '', nextHref)
  return nextHref
}

export function resolveDocumentBlockIdFromHash(hash: string) {
  if (!hash.startsWith('#')) {
    return null
  }

  const blockId = safeDecodeURIComponent(hash.slice(1)).trim()

  return blockId.length > 0 ? blockId : null
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}
