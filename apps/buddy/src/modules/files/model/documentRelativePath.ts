export function isDocumentRelativeImage(src: string): boolean {
  return !/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[#?/\\]/.test(src)
}

export function documentRelativePath(documentPath: string, src: string): string | null {
  if (!isDocumentRelativeImage(src))
    return null
  let relative: string
  try {
    relative = decodeURIComponent(src.split(/[?#]/, 1)[0]!)
  }
  catch { return null }
  if (!relative || relative.includes('\0') || /^[\\/]/.test(relative))
    return null

  const windowsRoot = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/])/i.exec(documentPath)?.[0]
  const separator = windowsRoot && documentPath.includes('\\') ? '\\' : '/'
  const root = windowsRoot?.replace(/[\\/]/g, separator) ?? (documentPath.startsWith('/') ? '/' : '')
  const segments = documentPath.slice(root.length).split(windowsRoot ? /[\\/]/ : /\//).filter(Boolean)
  segments.pop()
  for (const part of relative.split(/[\\/]/)) {
    if (part === '' || part === '.')
      continue
    if (part !== '..') {
      segments.push(part)
      continue
    }
    if (!segments.length)
      return null
    segments.pop()
  }
  return segments.length ? `${root}${segments.join(separator)}` : null
}
