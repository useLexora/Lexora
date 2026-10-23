const MEDIA_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/ogg'],
  ['flac', 'audio/flac'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['weba', 'audio/webm'],
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['webm', 'video/webm'],
  ['ogv', 'video/ogg'],
  ['mov', 'video/quicktime'],
])

const FILE_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html'],
  ['.html', 'text/html'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.mdown', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.py', 'text/x-python'],
  ['.rs', 'text/x-rust'],
  ['.scss', 'text/x-scss'],
  ['.svg', 'image/svg+xml'],
  ['.toml', 'application/toml'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript-jsx'],
  ['.tsv', 'text/tab-separated-values'],
  ['.txt', 'text/plain'],
  ['.vue', 'text/x-vue'],
  ['.webp', 'image/webp'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.xml', 'application/xml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.zip', 'application/zip'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
])

const IMAGE_MIME_TYPES = new Set([...FILE_MIME_TYPES.values()].filter(value => value.startsWith('image/')))

export function isImageMimeType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType)
}

export function inferFileMimeType(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return MEDIA_MIME_TYPES.get(extension) ?? FILE_MIME_TYPES.get(`.${extension}`) ?? 'application/octet-stream'
}

export function mediaKindForMimeType(mimeType: string): 'audio' | 'video' | null {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (![...MEDIA_MIME_TYPES.values()].includes(normalized))
    return null
  return normalized.startsWith('audio/') ? 'audio' : 'video'
}
