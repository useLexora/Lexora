export function localFileLinkPath(href: string): string | null {
  let path = href.trim()
  if (!path || path.startsWith('#') || path.startsWith('?'))
    return null
  if (path.startsWith('sandbox:'))
    path = path.slice(8)
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      if (url.hostname && url.hostname !== 'localhost')
        return null
      path = url.pathname
    }
    catch { return null }
  }
  else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
    return null
  }
  path = path.split('#')[0]!.split('?')[0]!
  try {
    path = decodeURIComponent(path)
  }
  catch { return null }
  path = path.replace(/^\/([a-z]:[\\/])/i, '$1')
  return path && !path.includes('\0') ? path : null
}
