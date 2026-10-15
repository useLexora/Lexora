const files = import.meta.glob<string>('./assets/material/*.svg', { eager: true, query: '?url&no-inline', import: 'default' })
const folders = import.meta.glob<string>('./assets/material-folders/*.svg', { eager: true, query: '?url&no-inline', import: 'default' })

function indexAssets(assets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(assets).map(([path, url]) => [path.split('/').at(-1)!.slice(0, -4), url]))
}
export const FILE_ICON_URLS = indexAssets(files)
export const FOLDER_ICON_URLS = indexAssets(folders)
export type FileIconName = string
