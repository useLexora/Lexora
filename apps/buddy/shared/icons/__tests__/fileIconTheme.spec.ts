import { describe, expect, it } from 'vitest'
import { fileIconThemeDocumentSchema, normalizeFileIconTheme, resolveFileIconDefinition } from '../fileIconTheme'

const icons = ['file', 'folder', 'open', 'name', 'parentName', 'ts', 'declaration', 'parentExtension', 'language', 'light', 'highContrast', 'namedFolder', 'root']
const document = normalizeFileIconTheme(fileIconThemeDocumentSchema.parse({
  iconDefinitions: Object.fromEntries(icons.map(id => [id, { iconPath: `${id}.svg` }])),
  file: 'file',
  folder: 'folder',
  folderExpanded: 'open',
  rootFolder: 'root',
  fileNames: { 'EXAMPLE.d.ts': 'name', 'special/example.d.ts': 'parentName' },
  fileExtensions: { 'ts': 'ts', 'd.ts': 'declaration', 'special/ts': 'parentExtension' },
  languageIds: { typescript: 'language' },
  folderNames: { src: 'namedFolder' },
  light: { fileExtensions: { ts: 'light' } },
  highContrast: { file: 'highContrast' },
}))

describe('file icon theme matching', () => {
  it.each([
    ['special/EXAMPLE.d.ts', 'parentName'],
    ['other/example.d.ts', 'name'],
    ['other/another.d.ts', 'declaration'],
    ['special/another.d.ts', 'parentExtension'],
    ['C:\\source\\another.ts', 'ts'],
    ['constructor', 'file'],
    ['__proto__', 'file'],
    ['other.constructor', 'file'],
  ])('resolves %s by name, parent and longest extension', (path, expected) => {
    expect(resolveFileIconDefinition(document, { path, kind: 'file' }, 'dark')).toBe(expected)
  })

  it('uses language fallback and overlays appearance without losing specific associations', () => {
    expect(resolveFileIconDefinition(document, { path: 'unknown', kind: 'file', languageId: 'typescript' }, 'dark')).toBe('language')
    expect(resolveFileIconDefinition(document, { path: 'file.ts', kind: 'file' }, 'light')).toBe('light')
    expect(resolveFileIconDefinition(document, { path: 'file.d.ts', kind: 'file' }, 'light')).toBe('declaration')
    expect(resolveFileIconDefinition(document, { path: 'unknown', kind: 'file' }, 'highContrast')).toBe('highContrast')
  })

  it('preserves named directory icons and falls back for expanded and root directories', () => {
    expect(resolveFileIconDefinition(document, { path: 'src', kind: 'directory', expanded: true }, 'dark')).toBe('namedFolder')
    expect(resolveFileIconDefinition(document, { path: 'other', kind: 'directory', expanded: true }, 'dark')).toBe('open')
    expect(resolveFileIconDefinition(document, { path: 'src', kind: 'directory', root: true, expanded: true }, 'dark')).toBe('root')
  })

  it('rejects unresolved definitions and executable or font theme fields', () => {
    expect(fileIconThemeDocumentSchema.safeParse({ ...document, file: 'absent' }).success).toBe(false)
    expect(fileIconThemeDocumentSchema.safeParse({ ...document, fonts: [] }).success).toBe(false)
    expect(fileIconThemeDocumentSchema.safeParse({ ...document, iconDefinitions: { script: { iconPath: 'x.svg', script: 'run()' } } }).success).toBe(false)
  })
})
