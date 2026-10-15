import { describe, expect, it } from 'vitest'
import { validFileName } from '../fileName'

describe('file names', () => {
  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\0b'])('rejects path components on all hosts: %s', (name) => {
    for (const platform of ['win32', 'linux', 'darwin'])
      expect(validFileName(name, platform)).toBe(false)
  })

  it.each(['CON', 'con.txt', 'NUL .txt', 'COM¹', 'LPT².log', 'COM³.txt', 'CONIN$', 'file:stream', 'trailing.', 'trailing ', 'a'.repeat(256), '📝'.repeat(128), 'file\u0001.txt', 'file\u001F.txt'])('rejects Windows names: %s', (name) => {
    expect(validFileName(name, 'win32')).toBe(false)
  })

  it.each(['COM10.txt', 'conifer.txt', '操作📝.md', 'COM1 notes.txt', 'a'.repeat(255), '📝'.repeat(127)])('preserves valid names: %s', (name) => {
    expect(validFileName(name, 'win32')).toBe(true)
  })

  it('does not impose Windows device and character rules on Unix', () => {
    for (const platform of ['linux', 'darwin']) {
      expect(validFileName('CON:notes?', platform)).toBe(true)
      expect(validFileName('trailing. ', platform)).toBe(true)
    }
  })
})
