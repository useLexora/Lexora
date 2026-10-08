import { describe, expect, it } from 'vitest'
import { spaceFileMutationSchema } from '../spaceFileApi'
import { pathInFileScope, validSpaceFileName } from '../spaceFileNames'

describe('workspace file names and boundaries', () => {
  it.each(['', '.', '..', 'a/b', 'a\\b', 'NUL', 'con.txt', 'COM1', 'lpt¹.txt', 'CONIN$', 'a:b', 'a?b', 'a.', 'a ', `a${String.fromCharCode(0)}b`, `a${String.fromCharCode(31)}b`])('rejects %j without rewriting it', (name) => {
    expect(validSpaceFileName(name)).toBe(false)
  })
  it.each(['note.md', '你好.txt', '.gitignore', 'new folder', 'COM10.txt', 'file😀.md'])('accepts %j', (name) => {
    expect(validSpaceFileName(name)).toBe(true)
  })
  it('matches descendants only at path boundaries', () => {
    expect(pathInFileScope('src', 'src')).toBe(true)
    expect(pathInFileScope('src/child/a.ts', 'src')).toBe(true)
    expect(pathInFileScope('src-other/a.ts', 'src')).toBe(false)
    expect(pathInFileScope('a.ts', '')).toBe(false)
  })
  it('accepts only bounded operation payloads, not absolute-path or command parameters', () => {
    const target = { spaceId: 'space', directoryId: 'directory', revision: 1, path: '' }
    expect(spaceFileMutationSchema.safeParse({ ...target, operation: 'create-file', name: 'file' }).success).toBe(true)
    expect(spaceFileMutationSchema.safeParse({ ...target, operation: 'trash', absolutePath: 'C:/private' }).success).toBe(false)
    expect(spaceFileMutationSchema.safeParse({ ...target, operation: 'shell', command: 'anything' }).success).toBe(false)
    expect(spaceFileMutationSchema.safeParse({ ...target, operation: 'trash', name: 'anything' }).success).toBe(false)
  })
})
