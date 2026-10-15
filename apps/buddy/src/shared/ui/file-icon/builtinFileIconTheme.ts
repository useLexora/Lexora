import type { FileIconThemeDocument } from '@buddy-shared/icons/fileIconTheme'
import { normalizeFileIconTheme } from '@buddy-shared/icons/fileIconTheme'
import { FILE_ICON_URLS, FOLDER_ICON_URLS } from './iconUrls'
import files from './materialFileAssociations.json'
import folders from './materialFolderAssociations.json'

export const builtinIconUrls: Readonly<Record<string, string>> = { ...FILE_ICON_URLS, ...FOLDER_ICON_URLS }
const variants = folders.icons as Record<string, { collapsed: string, expanded: string, light?: string, lightExpanded?: string }>
export const builtinFileIconTheme: FileIconThemeDocument = normalizeFileIconTheme({
  file: 'file',
  folder: 'folder',
  folderExpanded: 'folder-open',
  fileNames: files.names,
  fileExtensions: files.extensions,
  folderNames: folders.names,
  folderNamesExpanded: Object.fromEntries(Object.entries(folders.names).map(([name, id]) => [name, variants[id]!.expanded])),
  light: {
    folderNames: Object.fromEntries(Object.entries(folders.names).flatMap(([name, id]) => variants[id]!.light ? [[name, variants[id]!.light!]] : [])),
    folderNamesExpanded: Object.fromEntries(Object.entries(folders.names).flatMap(([name, id]) => variants[id]!.lightExpanded ? [[name, variants[id]!.lightExpanded!]] : [])),
  },
  iconDefinitions: Object.fromEntries(Object.keys(builtinIconUrls).map(id => [id, { iconPath: id }])),
})
